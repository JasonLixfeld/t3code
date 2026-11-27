import { EnvironmentId, MissionError, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import type { MissionUpdateEvent } from "./missionStatus.ts";
import { newTombstoneCheck, type TombstoneCheck } from "./tombstoneChecks.ts";

/**
 * Effect's SQL migrator skips IDs up to the last applied one. A separate database keeps fork and
 * upstream migration IDs from colliding.
 */
export const MISSIONS_DATABASE_FILE = "missions.sqlite";

export const MIGRATIONS = {
  "1_Missions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE missions (
        mission_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lead_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE claims (
        thread_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        mission_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
        owner TEXT NOT NULL,
        generation TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX claims_by_owner ON claims (owner)`;
    yield* sql`CREATE TABLE unsynced_tags (thread_id TEXT PRIMARY KEY)`;
    yield* sql`
      CREATE TABLE pending_releases (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        PRIMARY KEY (environment_id, thread_id, generation)
      )
    `;
  }),
  "2_LastKnown": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE known_machines (environment_id TEXT PRIMARY KEY)`;
    yield* sql`
      CREATE TABLE known_claims (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        mission_name TEXT NOT NULL,
        generation TEXT NOT NULL,
        PRIMARY KEY (environment_id, thread_id)
      )
    `;
  }),
  "3_PendingAdds": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE pending_adds (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        refusal TEXT,
        PRIMARY KEY (environment_id, thread_id)
      )
    `;
    yield* sql`DROP TABLE known_machines`;
  }),
  "4_AddIntents": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE pending_adds RENAME TO pending_adds_by_thread`;
    yield* sql`
      CREATE TABLE pending_adds (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        refusal TEXT,
        PRIMARY KEY (environment_id, thread_id, mission_id)
      )
    `;
    yield* sql`
      INSERT INTO pending_adds (environment_id, thread_id, mission_id, intent_id, refusal)
      SELECT environment_id, thread_id, mission_id, lower(hex(randomblob(16))), refusal
      FROM pending_adds_by_thread
    `;
    yield* sql`DROP TABLE pending_adds_by_thread`;
    yield* sql`ALTER TABLE claims ADD COLUMN intent_id TEXT`;
    yield* sql`
      CREATE TABLE spent_intents (
        mission_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        spent_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, owner, intent_id)
      )
    `;
  }),
  "5_AddLinkAndAge": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Rows from before have neither, so they read as made under another link, long ago.
    yield* sql`ALTER TABLE pending_adds ADD COLUMN link_id TEXT NOT NULL DEFAULT ''`;
    yield* sql`ALTER TABLE pending_adds ADD COLUMN added_at TEXT NOT NULL DEFAULT ''`;
  }),
  "6_MissionTombstones": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE mission_machines (
        mission_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        PRIMARY KEY (mission_id, environment_id)
      )
    `;
    // Earlier builds kept no such list. What they still remember names those machines: adds
    // waiting, refused or given up on, releases waiting, and claims last seen.
    yield* sql`
      INSERT OR IGNORE INTO mission_machines (mission_id, environment_id)
      SELECT mission_id, environment_id FROM pending_adds
      UNION SELECT mission_id, environment_id FROM pending_releases
      UNION SELECT mission_id, environment_id FROM known_claims
    `;
    yield* sql`
      CREATE TABLE deleted_missions (mission_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)
    `;
    yield* sql`
      CREATE TABLE tombstone_checks (
        environment_id TEXT PRIMARY KEY,
        answered_at INTEGER,
        retry_ms INTEGER NOT NULL,
        next_at INTEGER NOT NULL
      )
    `;
  }),
  "7_MissionLeadPrompt": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE missions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`;
    yield* sql`ALTER TABLE pending_adds ADD COLUMN actor TEXT`;
    yield* sql`ALTER TABLE pending_releases ADD COLUMN actor TEXT`;
    yield* sql`ALTER TABLE pending_releases ADD COLUMN refusal TEXT`;
    yield* sql`
      CREATE TABLE mission_updates (
        mission_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event TEXT NOT NULL,
        delivery_key TEXT,
        delivery_lead TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (mission_id, environment_id, thread_id, source)
      )
    `;
    yield* sql`
      CREATE TABLE member_numbers (
        mission_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        PRIMARY KEY (mission_id, environment_id, thread_id)
      )
    `;
    yield* sql`CREATE TABLE machine_numbers (environment_id TEXT PRIMARY KEY, number INTEGER NOT NULL)`;
    yield* sql`
      CREATE TABLE member_marks (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mark TEXT NOT NULL,
        PRIMARY KEY (environment_id, thread_id)
      )
    `;
    yield* sql`CREATE TABLE former_leads (thread_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT OR IGNORE INTO former_leads SELECT lead_thread_id FROM missions`;
    yield* sql`
      CREATE TABLE started_joins (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        released INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (environment_id, thread_id, mission_id)
      )
    `;
  }),
  "8_JoinedWithPriorWork": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE pending_adds ADD COLUMN no_brief INTEGER NOT NULL DEFAULT 0`;
    yield* sql`
      UPDATE pending_adds SET no_brief = 1 WHERE EXISTS (
        SELECT 1 FROM started_joins WHERE started_joins.mission_id = pending_adds.mission_id
          AND started_joins.intent_id = pending_adds.intent_id
      )
    `;
    yield* sql`ALTER TABLE member_numbers ADD COLUMN joined_generation TEXT`;
  }),
  "9_LeadSince": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE missions ADD COLUMN lead_since TEXT NOT NULL DEFAULT ''`;
    yield* sql`UPDATE missions SET lead_since = created_at`;
  }),
};
const migrations = Migrator.fromRecord(MIGRATIONS);

interface MissionRow {
  readonly mission_id: string;
  readonly name: string;
  readonly lead_thread_id: string;
  readonly created_at: string;
  readonly prompt: string;
}
interface ClaimRow {
  readonly thread_id: string;
  readonly mission_id: string;
  readonly mission_name: string;
  readonly role: MissionClaim["role"];
  readonly owner: string;
  readonly generation: string;
  readonly intent_id: string | null;
}
interface KnownClaimRow extends Omit<ClaimRow, "role" | "owner" | "intent_id"> {
  readonly environment_id: string;
}
interface PendingReleaseRow {
  readonly environment_id: string;
  readonly thread_id: string;
  readonly generation: string;
  readonly mission_id: string;
}

export interface MissionRecord {
  readonly missionId: string;
  readonly name: string;
  readonly leadThreadId: ThreadId;
  readonly createdAt: string;
  readonly prompt: string;
}

interface MissionUpdate {
  readonly missionId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly source: string;
  readonly event: MissionUpdateEvent;
}

export interface MissionClaim {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  readonly role: "lead" | "member";
  readonly generation: string;
}

export interface PendingAdd {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly intentId: string;
  readonly linkId: string;
  readonly addedAt: string;
  readonly refusal: string | null;
  readonly actor?: ThreadId | undefined;
  readonly noBrief?: true | undefined;
}

type AddKey = Pick<PendingAdd, "environmentId" | "threadId" | "missionId">;

const SPENT_INTENT_DAYS = 30;
const STARTED_JOIN_DAYS = 30;

interface StartedThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly missionId: string;
}

interface Numbers {
  readonly member: ReadonlyMap<string, number>;
  readonly machine: ReadonlyMap<EnvironmentId, number>;
}

export const numberKey = (ref: { readonly environmentId: string; readonly threadId: string }) =>
  `${ref.environmentId}\u0000${ref.threadId}`;

export interface PendingRelease {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly missionId: string;
  readonly actor?: ThreadId | undefined;
  readonly refusal?: string | undefined;
}

interface ClaimInput {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  readonly owner: string;
  readonly generation: string;
  readonly intentId?: string | undefined;
  readonly ledHere?: boolean | undefined;
  readonly announce?: boolean | undefined;
}

const actorOf = (row: { readonly actor: string | null }) =>
  row.actor === null ? {} : { actor: ThreadId.make(row.actor) };

const deliveryKey = (
  lead: ThreadId,
  rows: ReadonlyArray<MissionUpdate & { readonly attempt: number }>,
) => {
  let hash = 0xcbf29ce484222325n;
  const text = [
    lead,
    ...rows
      .map((row) => [row.environmentId, row.threadId, row.source, row.attempt].join("\u0000"))
      .toSorted(),
  ].join("\u0001");
  for (const unit of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(unit)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

const toMission = (row: MissionRow): MissionRecord => ({
  missionId: row.mission_id,
  name: row.name,
  leadThreadId: ThreadId.make(row.lead_thread_id),
  createdAt: row.created_at,
  prompt: row.prompt,
});

const toClaim = (row: Omit<ClaimRow, "owner" | "intent_id">): MissionClaim => ({
  threadId: ThreadId.make(row.thread_id),
  missionId: row.mission_id,
  name: row.mission_name,
  role: row.role,
  generation: row.generation,
});

const refuse = (message: string) => new MissionError({ message });
const isRefusal = Schema.is(MissionError);
const heldElsewhere = (held: ClaimRow) =>
  refuse(
    `This thread is already in the mission "${held.mission_name}". It must leave that mission first.`,
  );

export const MISSION_NOT_ENDED =
  "Its active threads must leave this mission, and its pending adds must be cleared, before you end it.";

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** Claim writes run only under MissionClaims' per-thread lock. */
export class MissionStore extends Context.Service<
  MissionStore,
  {
    readonly changes: PubSub.PubSub<void>;
    readonly missions: Effect.Effect<ReadonlyArray<MissionRecord>>;
    readonly createMission: (lead: ClaimInput) => Effect.Effect<MissionRecord, MissionError>;
    readonly setLead: (
      lead: ClaimInput & { readonly previous: ThreadId },
    ) => Effect.Effect<MissionRecord, MissionError>;
    readonly deleteMission: (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
      readonly machines: ReadonlyArray<EnvironmentId>;
      readonly owner: string;
      readonly checkedLocalMembers: ReadonlyArray<ThreadId>;
      readonly leadSettledAt?: DateTime.Utc | undefined;
    }) => Effect.Effect<void, MissionError>;
    readonly join: (
      input: ClaimInput,
    ) => Effect.Effect<MissionClaim | "intent-spent", MissionError>;
    readonly release: (input: Omit<ClaimInput, "name">) => Effect.Effect<boolean>;
    readonly leave: (threadId: ThreadId, missionId?: string) => Effect.Effect<void, MissionError>;
    readonly renameMission: (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
      readonly name: string;
    }) => Effect.Effect<string>;
    readonly renameClaim: (input: {
      readonly threadId: ThreadId;
      readonly owner: string;
      readonly missionId: string;
      readonly name: string;
    }) => Effect.Effect<boolean>;
    readonly claim: (threadId: ThreadId) => Effect.Effect<MissionClaim | undefined>;
    readonly claimsOf: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
    readonly allClaims: Effect.Effect<ReadonlyArray<MissionClaim>>;
    readonly unsyncedTags: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly tagsSynced: (threadId: ThreadId) => Effect.Effect<void>;
    readonly pendingReleases: Effect.Effect<ReadonlyArray<PendingRelease>>;
    readonly addPendingRelease: (release: PendingRelease) => Effect.Effect<void>;
    readonly clearPendingRelease: (
      release: Omit<PendingRelease, "missionId">,
    ) => Effect.Effect<void>;
    readonly pendingAdds: Effect.Effect<ReadonlyArray<PendingAdd>>;
    readonly setPendingAdd: (add: PendingAdd) => Effect.Effect<void>;
    readonly deletedMissionIds: Effect.Effect<ReadonlySet<string>>;
    readonly tombstoneChecks: Effect.Effect<ReadonlyArray<TombstoneCheck>>;
    readonly setTombstoneCheck: (
      environmentId: EnvironmentId,
      check: TombstoneCheck | null,
    ) => Effect.Effect<void>;
    readonly clearPendingAdd: (add: AddKey) => Effect.Effect<void>;
    readonly settleAdd: (
      add: AddKey,
      claim: MissionClaim,
      announce: boolean,
    ) => Effect.Effect<void>;
    readonly knownClaims: Effect.Effect<ReadonlyMap<EnvironmentId, ReadonlyArray<MissionClaim>>>;
    readonly setKnownClaims: (
      environmentId: EnvironmentId,
      claims: ReadonlyArray<MissionClaim>,
    ) => Effect.Effect<void>;
    readonly forgetClaim: (release: Omit<PendingRelease, "missionId">) => Effect.Effect<void>;
    readonly forgetThread: (thread: AddKey) => Effect.Effect<void>;
    readonly setPrompt: (input: {
      readonly missionId: string;
      readonly prompt: string;
    }) => Effect.Effect<void, MissionError>;
    readonly addMissionUpdate: (update: MissionUpdate) => Effect.Effect<void>;
    readonly markMissionUpdateHeard: (update: MissionUpdate) => Effect.Effect<void>;
    readonly missionsWithUpdates: Effect.Effect<ReadonlyArray<string>>;
    readonly takeMissionUpdates: (
      missionId: string,
      lead: ThreadId,
    ) => Effect.Effect<{ readonly key: string; readonly updates: ReadonlyArray<MissionUpdate> }>;
    readonly rekeyMissionUpdates: (missionId: string, key: string) => Effect.Effect<void>;
    readonly clearMissionUpdates: (
      missionId: string,
      key: string,
      held?: ReadonlyArray<Pick<MissionUpdate, "environmentId" | "threadId" | "source">>,
    ) => Effect.Effect<void>;
    readonly memberMark: (member: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<string | undefined>;
    readonly setMemberMark: (
      member: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
      mark: string,
    ) => Effect.Effect<void>;
    readonly ledBefore: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly startJoin: (
      thread: StartedThread,
      intentId: string,
    ) => Effect.Effect<{
      readonly state: "first" | "requested" | "released";
      readonly intentId: string;
    }>;
    readonly forgetStartedJoin: (thread: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly startedReleased: (thread: StartedThread) => Effect.Effect<void>;
    readonly numbersOf: (
      missionId: string,
      members: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
      }>,
      here: EnvironmentId,
    ) => Effect.Effect<Numbers>;
    readonly numbersKnown: (missionId: string) => Effect.Effect<Numbers>;
    readonly refusePendingRelease: (
      release: PendingRelease,
      refusal: string,
    ) => Effect.Effect<void>;
  }
>()("t3/missions/MissionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* Migrator.make({})({ loader: migrations });
  const changes = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(changes, undefined);

  const change = <A>(body: Effect.Effect<A | MissionError, SqlError.SqlError>) =>
    sql.withTransaction(body).pipe(
      Effect.orDie,
      Effect.flatMap((outcome) =>
        isRefusal(outcome)
          ? Effect.fail(outcome)
          : Effect.as(changed, outcome as Exclude<A, MissionError>),
      ),
    );

  const claimRow = (threadId: ThreadId) =>
    sql<ClaimRow>`
      SELECT thread_id, mission_id, mission_name, role, owner, generation, intent_id FROM claims
      WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]));

  const spendIntent = Effect.fn("MissionStore.spendIntent")(function* (held: ClaimRow) {
    if (held.intent_id === null) return;
    const spentAt = yield* DateTime.now;
    const oldest = DateTime.formatIso(DateTime.subtract(spentAt, { days: SPENT_INTENT_DAYS }));
    yield* sql`DELETE FROM spent_intents WHERE spent_at < ${oldest}`;
    yield* sql`
      INSERT OR IGNORE INTO spent_intents (mission_id, owner, intent_id, spent_at)
      VALUES (${held.mission_id}, ${held.owner}, ${held.intent_id}, ${DateTime.formatIso(spentAt)})
    `;
  });

  const writeTombstoneCheck = (check: TombstoneCheck) => sql`
    INSERT OR REPLACE INTO tombstone_checks (environment_id, answered_at, retry_ms, next_at)
    VALUES (${check.environmentId}, ${check.answeredAt}, ${check.retryMs}, ${check.nextAt})
  `;

  const markUnsynced = (threadId: ThreadId) =>
    sql`INSERT OR IGNORE INTO unsynced_tags (thread_id) VALUES (${threadId})`;

  const insertClaim = (input: ClaimInput, role: MissionClaim["role"], claimedAt: string) =>
    sql`
      INSERT INTO claims
        (thread_id, mission_id, mission_name, role, owner, generation, claimed_at, intent_id)
      VALUES (${input.threadId}, ${input.missionId}, ${input.name}, ${role}, ${input.owner},
        ${input.generation}, ${claimedAt}, ${input.intentId ?? null})
    `.pipe(
      Effect.andThen(markUnsynced(input.threadId)),
      Effect.as<MissionClaim>({
        threadId: input.threadId,
        missionId: input.missionId,
        name: input.name,
        role,
        generation: input.generation,
      }),
    );

  const missions = sql<MissionRow>`
    SELECT mission_id, name, lead_thread_id, created_at, prompt FROM missions ORDER BY created_at, rowid
  `.pipe(
    Effect.map((rows) => rows.map(toMission)),
    Effect.orDie,
    Effect.withSpan("MissionStore.missions"),
  );

  const createMission = Effect.fn("MissionStore.createMission")(function* (lead: ClaimInput) {
    return yield* change(
      Effect.gen(function* () {
        const createdAt = yield* now;
        const [deleted] = yield* sql`
          SELECT 1 FROM deleted_missions WHERE mission_id = ${lead.missionId}
        `;
        if (deleted !== undefined) return refuse("That mission has ended.");
        const existing = yield* sql<MissionRow>`
          SELECT mission_id, name, lead_thread_id, created_at, prompt FROM missions
          WHERE mission_id = ${lead.missionId}
        `;
        if (existing[0] !== undefined) {
          return existing[0].lead_thread_id === lead.threadId
            ? toMission(existing[0])
            : refuse("Another mission already uses this id.");
        }
        const held = yield* claimRow(lead.threadId);
        if (held !== undefined) return heldElsewhere(held);
        yield* sql`
          INSERT INTO missions (mission_id, name, lead_thread_id, created_at, lead_since)
          VALUES (${lead.missionId}, ${lead.name}, ${lead.threadId}, ${createdAt}, ${createdAt})
        `;
        yield* sql`INSERT OR IGNORE INTO former_leads (thread_id) VALUES (${lead.threadId})`;
        yield* insertClaim(lead, "lead", createdAt);
        return toMission({
          mission_id: lead.missionId,
          name: lead.name,
          lead_thread_id: lead.threadId,
          created_at: createdAt,
          prompt: "",
        });
      }),
    );
  });

  const deleteMission = Effect.fn("MissionStore.deleteMission")(function* (input: {
    readonly missionId: string;
    readonly lead: ThreadId;
    readonly machines: ReadonlyArray<EnvironmentId>;
    readonly owner: string;
    readonly checkedLocalMembers: ReadonlyArray<ThreadId>;
    readonly leadSettledAt?: DateTime.Utc | undefined;
  }) {
    const asked = DateTime.toEpochMillis(yield* DateTime.now);
    return yield* change(
      Effect.gen(function* () {
        const [mission] = yield* sql<{
          readonly lead_thread_id: string;
          readonly lead_since: string;
          readonly created_at: string;
        }>`
          SELECT lead_thread_id, lead_since, created_at FROM missions
          WHERE mission_id = ${input.missionId}
        `;
        if (mission === undefined) return refuse("That mission was not found.");
        const since = Date.parse(mission.lead_since);
        const leadSince = Number.isNaN(since) ? Date.parse(mission.created_at) : since;
        if (
          mission.lead_thread_id !== input.lead ||
          (input.leadSettledAt !== undefined &&
            !(leadSince < DateTime.toEpochMillis(input.leadSettledAt)))
        ) {
          return new MissionError({
            message: "This mission already has a new lead.",
            reason: "lead-changed",
          });
        }
        const [held] = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM known_claims WHERE mission_id = ${input.missionId}
          UNION ALL SELECT 1 FROM pending_adds
            WHERE mission_id = ${input.missionId} AND refusal IS NULL
          UNION ALL SELECT 1 FROM pending_releases
            WHERE mission_id = ${input.missionId} AND refusal IS NULL
          LIMIT 1
        `;
        const members = yield* sql<ClaimRow>`
          SELECT thread_id, mission_id, mission_name, role, owner, generation, intent_id FROM claims
          WHERE mission_id = ${input.missionId} AND role = 'member' AND owner = ${input.owner}
        `;
        const settled = new Set<string>(input.checkedLocalMembers);
        if (held !== undefined || members.some((member) => !settled.has(member.thread_id))) {
          return refuse(MISSION_NOT_ENDED);
        }
        for (const member of members) {
          yield* spendIntent(member);
          yield* sql`DELETE FROM claims WHERE thread_id = ${member.thread_id}`;
          yield* markUnsynced(ThreadId.make(member.thread_id));
        }
        yield* sql`DELETE FROM pending_adds WHERE mission_id = ${input.missionId}`;
        yield* sql`DELETE FROM pending_releases WHERE mission_id = ${input.missionId}`;
        yield* sql`DELETE FROM mission_updates WHERE mission_id = ${input.missionId}`;
        yield* sql`
          DELETE FROM claims WHERE thread_id = ${input.lead} AND mission_id = ${input.missionId}
        `;
        yield* sql`DELETE FROM missions WHERE mission_id = ${input.missionId}`;
        yield* sql`
          INSERT INTO deleted_missions (mission_id, deleted_at)
          VALUES (${input.missionId}, ${yield* now})
        `;
        const sentTo = yield* sql<{ readonly environment_id: string }>`
          SELECT environment_id FROM mission_machines WHERE mission_id = ${input.missionId}
        `;
        const machines = new Set([
          ...input.machines,
          ...sentTo.map((row) => EnvironmentId.make(row.environment_id)),
        ]);
        for (const environmentId of machines) {
          yield* writeTombstoneCheck(newTombstoneCheck(environmentId, asked));
        }
        yield* markUnsynced(input.lead);
      }),
    );
  });

  const setLead = Effect.fn("MissionStore.setLead")(function* (
    lead: ClaimInput & { readonly previous: ThreadId },
  ) {
    const claimedAt = yield* now;
    return yield* change(
      Effect.gen(function* () {
        const [mission] = yield* sql<MissionRow>`
          SELECT mission_id, name, lead_thread_id, created_at, prompt FROM missions
          WHERE mission_id = ${lead.missionId}
        `;
        if (mission === undefined) return refuse("That mission was not found.");
        const previous = ThreadId.make(mission.lead_thread_id);
        if (previous === lead.threadId) return toMission(mission);
        if (previous !== lead.previous) {
          return new MissionError({
            message: "This mission already has a new lead.",
            reason: "lead-changed",
          });
        }
        const held = yield* claimRow(lead.threadId);
        if (
          held !== undefined &&
          (held.mission_id !== lead.missionId || held.owner !== lead.owner)
        ) {
          return heldElsewhere(held);
        }
        if (held === undefined) yield* insertClaim(lead, "lead", claimedAt);
        else {
          yield* sql`
            UPDATE claims SET role = 'lead', mission_name = ${lead.name}
            WHERE thread_id = ${lead.threadId}
          `;
          yield* markUnsynced(lead.threadId);
        }
        if (previous !== lead.threadId) {
          yield* sql`
            DELETE FROM claims
            WHERE thread_id = ${previous} AND mission_id = ${lead.missionId} AND role = 'lead'
          `;
          yield* markUnsynced(previous);
        }
        yield* sql`
          UPDATE missions
          SET lead_thread_id = ${lead.threadId}, name = ${lead.name}, lead_since = ${claimedAt}
          WHERE mission_id = ${lead.missionId}
        `;
        yield* sql`INSERT OR IGNORE INTO former_leads (thread_id) VALUES (${lead.threadId})`;
        yield* sql`
          DELETE FROM mission_updates
          WHERE mission_id = ${lead.missionId} AND thread_id = ${lead.threadId}
            AND delivery_key IS NULL
        `;
        return toMission({ ...mission, lead_thread_id: lead.threadId, name: lead.name });
      }),
    );
  });

  const announceJoin = Effect.fn("MissionStore.announceJoin")(function* (
    claim: Pick<MissionClaim, "missionId" | "threadId" | "generation"> & {
      readonly environmentId: EnvironmentId;
    },
  ) {
    const fresh = yield* sql`
        UPDATE member_numbers SET joined_generation = ${claim.generation}
        WHERE mission_id = ${claim.missionId} AND environment_id = ${claim.environmentId}
          AND thread_id = ${claim.threadId}
          AND (joined_generation IS NULL OR joined_generation != ${claim.generation})
        RETURNING number
      `;
    if (fresh.length === 0) return;
    yield* addMissionUpdate({
      missionId: claim.missionId,
      environmentId: claim.environmentId,
      threadId: claim.threadId,
      source: `joined:${claim.generation}`,
      event: "joined",
    });
  });

  const join = Effect.fn("MissionStore.join")(function* (input: ClaimInput) {
    const claimedAt = yield* now;
    return yield* change(
      Effect.gen(function* () {
        const { intentId } = input;
        if (intentId !== undefined) {
          const spent = yield* sql`
            SELECT 1 FROM spent_intents
            WHERE mission_id = ${input.missionId} AND intent_id = ${intentId}
          `;
          if (spent.length > 0) return "intent-spent" as const;
        }
        if (input.ledHere === true) {
          const [mission] = yield* sql`
            SELECT 1 FROM missions WHERE mission_id = ${input.missionId}
          `;
          if (mission === undefined) return refuse("This mission no longer exists.");
        }
        const held = yield* claimRow(input.threadId);
        if (held === undefined) {
          const claim = yield* insertClaim(input, "member", claimedAt);
          if (input.ledHere === true) {
            const member = { ...claim, environmentId: EnvironmentId.make(input.owner) };
            yield* numberMember(claim.missionId, member, false);
            if (input.announce === true) yield* announceJoin(member);
          }
          return claim;
        }
        if (held.owner !== input.owner || held.mission_id !== input.missionId) {
          return heldElsewhere(held);
        }
        if (intentId !== undefined && held.intent_id !== intentId) {
          yield* spendIntent(held);
          yield* sql`UPDATE claims SET intent_id = ${intentId} WHERE thread_id = ${input.threadId}`;
        }
        return toClaim(held);
      }),
    );
  });

  const release = Effect.fn("MissionStore.release")(function* (input: Omit<ClaimInput, "name">) {
    const dropped = yield* sql.withTransaction(
      Effect.gen(function* () {
        const held = yield* claimRow(input.threadId);
        if (
          held === undefined ||
          held.mission_id !== input.missionId ||
          held.generation !== input.generation ||
          held.owner !== input.owner ||
          held.role !== "member"
        ) {
          return false;
        }
        yield* spendIntent(held);
        yield* sql`DELETE FROM claims WHERE thread_id = ${input.threadId}`;
        yield* markUnsynced(input.threadId);
        return true;
      }),
    );
    yield* changed;
    return dropped;
  }, Effect.orDie);

  const leave = Effect.fn("MissionStore.leave")(function* (threadId: ThreadId, missionId?: string) {
    yield* change(
      Effect.gen(function* () {
        const held = yield* claimRow(threadId);
        if (held === undefined) return refuse("This thread is not in a mission.");
        if (missionId !== undefined && held.mission_id !== missionId) {
          return refuse("This thread is now in another mission, so it was not removed.");
        }
        if (held.role === "lead") {
          return refuse("A mission keeps its lead thread, so the lead cannot leave.");
        }
        yield* spendIntent(held);
        yield* sql`DELETE FROM claims WHERE thread_id = ${threadId}`;
        yield* markUnsynced(threadId);
      }),
    );
  });

  const renameMission = (input: {
    readonly missionId: string;
    readonly lead: ThreadId;
    readonly name: string;
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE missions SET name = ${input.name}
          WHERE mission_id = ${input.missionId} AND lead_thread_id = ${input.lead}
        `;
          const [row] = yield* sql<{ readonly name: string }>`
          SELECT name FROM missions WHERE mission_id = ${input.missionId}
        `;
          return row?.name ?? input.name;
        }),
      )
      .pipe(
        Effect.tap(() => changed),
        Effect.orDie,
      );

  const renameClaim = Effect.fn("MissionStore.renameClaim")(function* (input: {
    readonly threadId: ThreadId;
    readonly owner: string;
    readonly missionId: string;
    readonly name: string;
  }) {
    const renamed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`
          UPDATE claims SET mission_name = ${input.name}
          WHERE thread_id = ${input.threadId} AND owner = ${input.owner}
            AND mission_id = ${input.missionId} AND mission_name != ${input.name}
          RETURNING thread_id
        `;
        if (rows.length > 0) yield* markUnsynced(input.threadId);
        return rows.length > 0;
      }),
    );
    if (renamed) yield* changed;
    return renamed;
  }, Effect.orDie);

  const claim = Effect.fn("MissionStore.claim")(function* (threadId: ThreadId) {
    const held = yield* claimRow(threadId);
    return held === undefined ? undefined : toClaim(held);
  }, Effect.orDie);

  const claimsOf = Effect.fn("MissionStore.claimsOf")(function* (owner: string) {
    const rows = yield* sql<ClaimRow>`
      SELECT thread_id, mission_id, mission_name, role, owner, generation, intent_id FROM claims
      WHERE owner = ${owner} ORDER BY claimed_at, rowid
    `;
    return rows.map(toClaim);
  }, Effect.orDie);

  const allClaims = sql<ClaimRow>`
    SELECT thread_id, mission_id, mission_name, role, owner, generation, intent_id FROM claims
    ORDER BY claimed_at, rowid
  `.pipe(
    Effect.map((rows) => rows.map(toClaim)),
    Effect.orDie,
  );

  const unsyncedTags = sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM unsynced_tags
  `.pipe(
    Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
    Effect.orDie,
  );

  const tagsSynced = (threadId: ThreadId) =>
    sql`DELETE FROM unsynced_tags WHERE thread_id = ${threadId}`.pipe(Effect.asVoid, Effect.orDie);

  const pendingReleases = sql<
    PendingReleaseRow & { readonly actor: string | null; readonly refusal: string | null }
  >`
    SELECT environment_id, thread_id, generation, mission_id, actor, refusal
    FROM pending_releases ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): PendingRelease => ({
        environmentId: EnvironmentId.make(row.environment_id),
        threadId: ThreadId.make(row.thread_id),
        generation: row.generation,
        missionId: row.mission_id,
        ...actorOf(row),
        ...(row.refusal === null ? {} : { refusal: row.refusal }),
      })),
    ),
    Effect.orDie,
  );

  const touches = (missionId: string, environmentId: EnvironmentId) => sql`
    INSERT OR IGNORE INTO mission_machines (mission_id, environment_id)
    VALUES (${missionId}, ${environmentId})
  `;

  const addPendingRelease = (pending: PendingRelease) =>
    sql`
      INSERT OR REPLACE INTO pending_releases
        (environment_id, thread_id, generation, mission_id, actor, refusal)
      VALUES (${pending.environmentId}, ${pending.threadId}, ${pending.generation},
        ${pending.missionId}, ${pending.actor ?? null}, ${pending.refusal ?? null})
    `.pipe(
      Effect.andThen(touches(pending.missionId, pending.environmentId)),
      Effect.andThen(changed),
      Effect.asVoid,
      Effect.orDie,
    );

  const clearPendingRelease = (pending: Omit<PendingRelease, "missionId">) =>
    sql`
      DELETE FROM pending_releases
      WHERE environment_id = ${pending.environmentId} AND thread_id = ${pending.threadId}
        AND generation = ${pending.generation}
    `.pipe(Effect.andThen(changed), Effect.asVoid, Effect.orDie);

  const pendingAdds = sql<{
    readonly environment_id: string;
    readonly thread_id: string;
    readonly mission_id: string;
    readonly intent_id: string;
    readonly link_id: string;
    readonly added_at: string;
    readonly refusal: string | null;
    readonly actor: string | null;
    readonly no_brief: number;
  }>`
    SELECT environment_id, thread_id, mission_id, intent_id, link_id, added_at, refusal, actor,
      no_brief
    FROM pending_adds ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): PendingAdd => ({
        environmentId: EnvironmentId.make(row.environment_id),
        threadId: ThreadId.make(row.thread_id),
        missionId: row.mission_id,
        intentId: row.intent_id,
        linkId: row.link_id,
        addedAt: row.added_at,
        refusal: row.refusal,
        ...actorOf(row),
        ...(row.no_brief === 1 ? { noBrief: true as const } : {}),
      })),
    ),
    Effect.orDie,
  );

  const setPendingAdd = (add: PendingAdd) =>
    sql`
      INSERT OR REPLACE INTO pending_adds
        (environment_id, thread_id, mission_id, intent_id, link_id, added_at, refusal, actor,
          no_brief)
      VALUES (${add.environmentId}, ${add.threadId}, ${add.missionId}, ${add.intentId},
        ${add.linkId}, ${add.addedAt}, ${add.refusal}, ${add.actor ?? null},
        ${add.noBrief === true ? 1 : 0})
    `.pipe(
      Effect.andThen(touches(add.missionId, add.environmentId)),
      Effect.andThen(changed),
      Effect.asVoid,
      Effect.orDie,
    );

  const deletedMissionIds = sql<{ readonly mission_id: string }>`
    SELECT mission_id FROM deleted_missions
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.mission_id)) as ReadonlySet<string>),
    Effect.orDie,
  );

  const tombstoneChecks = sql<{
    readonly environment_id: string;
    readonly answered_at: number | null;
    readonly retry_ms: number;
    readonly next_at: number;
  }>`SELECT environment_id, answered_at, retry_ms, next_at FROM tombstone_checks`.pipe(
    Effect.map((rows) =>
      rows.map((row): TombstoneCheck => ({
        environmentId: EnvironmentId.make(row.environment_id),
        answeredAt: row.answered_at,
        retryMs: row.retry_ms,
        nextAt: row.next_at,
      })),
    ),
    Effect.orDie,
  );

  const setTombstoneCheck = (environmentId: EnvironmentId, check: TombstoneCheck | null) =>
    (check === null
      ? sql`DELETE FROM tombstone_checks WHERE environment_id = ${environmentId}`
      : writeTombstoneCheck(check)
    ).pipe(Effect.asVoid, Effect.orDie);

  const deletePendingAdd = (add: AddKey) =>
    sql`
      DELETE FROM pending_adds
      WHERE environment_id = ${add.environmentId} AND thread_id = ${add.threadId}
        AND mission_id = ${add.missionId}
    `;

  const clearPendingAdd = (add: AddKey) =>
    deletePendingAdd(add).pipe(Effect.andThen(changed), Effect.asVoid, Effect.orDie);

  const knownClaims = sql<KnownClaimRow>`
    SELECT environment_id, thread_id, mission_id, mission_name, generation FROM known_claims
    ORDER BY rowid
  `.pipe(
    Effect.map((rows) => {
      const machines = new Map<EnvironmentId, Array<MissionClaim>>();
      for (const row of rows) {
        const machine = EnvironmentId.make(row.environment_id);
        machines.set(machine, [
          ...(machines.get(machine) ?? []),
          toClaim({ ...row, role: "member" }),
        ]);
      }
      return machines;
    }),
    Effect.orDie,
  );

  const insertKnownClaim = (environmentId: EnvironmentId, held: MissionClaim) =>
    sql`
      INSERT OR REPLACE INTO known_claims
        (environment_id, thread_id, mission_id, mission_name, generation)
      VALUES (${environmentId}, ${held.threadId}, ${held.missionId}, ${held.name},
        ${held.generation})
    `.pipe(
      Effect.andThen(touches(held.missionId, environmentId)),
      Effect.andThen(numberMember(held.missionId, { ...held, environmentId }, true)),
    );

  const setKnownClaims = Effect.fn("MissionStore.setKnownClaims")(function* (
    environmentId: EnvironmentId,
    claims: ReadonlyArray<MissionClaim>,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM known_claims WHERE environment_id = ${environmentId}`;
        yield* Effect.forEach(claims, (held) => insertKnownClaim(environmentId, held));
      }),
    );
    yield* changed;
  }, Effect.orDie);

  const settleAdd = Effect.fn("MissionStore.settleAdd")(function* (
    add: AddKey,
    held: MissionClaim,
    announce: boolean,
  ) {
    yield* sql.withTransaction(
      deletePendingAdd(add).pipe(
        Effect.andThen(insertKnownClaim(add.environmentId, held)),
        Effect.andThen(
          announce ? announceJoin({ ...held, environmentId: add.environmentId }) : Effect.void,
        ),
      ),
    );
    yield* changed;
  }, Effect.orDie);

  const forgetClaim = (release: Omit<PendingRelease, "missionId">) =>
    sql`
      DELETE FROM known_claims
      WHERE environment_id = ${release.environmentId} AND thread_id = ${release.threadId}
        AND generation = ${release.generation}
    `.pipe(Effect.andThen(changed), Effect.asVoid, Effect.orDie);

  const forgetThread = Effect.fn("MissionStore.forgetThread")(function* (thread: AddKey) {
    const theThread = sql`environment_id = ${thread.environmentId}
      AND thread_id = ${thread.threadId} AND mission_id = ${thread.missionId}`;
    yield* sql.withTransaction(
      Effect.all([
        sql`DELETE FROM pending_adds WHERE ${theThread}`,
        sql`DELETE FROM pending_releases WHERE ${theThread}`,
        sql`DELETE FROM known_claims WHERE ${theThread}`,
      ]),
    );
    yield* changed;
  }, Effect.orDie);

  const setPrompt = Effect.fn("MissionStore.setPrompt")(function* (input: {
    readonly missionId: string;
    readonly prompt: string;
  }) {
    yield* change(
      Effect.gen(function* () {
        const rows = yield* sql`
          UPDATE missions SET prompt = ${input.prompt} WHERE mission_id = ${input.missionId}
          RETURNING mission_id
        `;
        return rows.length === 0 ? refuse("That mission was not found.") : undefined;
      }),
    );
  });

  const HEARD = "heard";
  const updateRows = (missionId: string) =>
    sql<{
      readonly mission_id: string;
      readonly environment_id: string;
      readonly thread_id: string;
      readonly source: string;
      readonly event: MissionUpdateEvent;
      readonly delivery_key: string | null;
      readonly delivery_lead: string | null;
      readonly attempt: number;
    }>`
      SELECT mission_id, environment_id, thread_id, source, event, delivery_key, delivery_lead,
        attempt
      FROM mission_updates WHERE mission_id = ${missionId} AND delivery_key IS NOT ${HEARD}
      ORDER BY rowid
    `;
  const toUpdate = (row: {
    readonly mission_id: string;
    readonly environment_id: string;
    readonly thread_id: string;
    readonly source: string;
    readonly event: MissionUpdateEvent;
  }): MissionUpdate => ({
    missionId: row.mission_id,
    environmentId: EnvironmentId.make(row.environment_id),
    threadId: ThreadId.make(row.thread_id),
    source: row.source,
    event: row.event,
  });

  const keepLatestWaitingPerMemberPreferringJoins = (missionId: string) => sql`
    DELETE FROM mission_updates
    WHERE mission_id = ${missionId} AND delivery_key IS NULL AND EXISTS (
      SELECT 1 FROM mission_updates AS newer
      WHERE newer.mission_id = mission_updates.mission_id
        AND newer.environment_id = mission_updates.environment_id
        AND newer.thread_id = mission_updates.thread_id
        AND newer.delivery_key IS NULL
        AND ((newer.event = 'joined') > (mission_updates.event = 'joined')
          OR ((newer.event = 'joined') = (mission_updates.event = 'joined')
            AND newer.rowid > mission_updates.rowid))
    )
  `;

  const addMissionUpdate = (update: MissionUpdate) =>
    sql`
      INSERT OR IGNORE INTO mission_updates (mission_id, environment_id, thread_id, source, event)
      SELECT ${update.missionId}, ${update.environmentId}, ${update.threadId}, ${update.source},
        ${update.event}
      WHERE EXISTS (SELECT 1 FROM missions WHERE mission_id = ${update.missionId})
    `.pipe(Effect.asVoid, Effect.orDie);

  const markMissionUpdateHeard = (update: MissionUpdate) =>
    sql`
      INSERT INTO mission_updates (mission_id, environment_id, thread_id, source, event, delivery_key)
      VALUES (${update.missionId}, ${update.environmentId}, ${update.threadId}, ${update.source},
        ${update.event}, ${HEARD})
      ON CONFLICT (mission_id, environment_id, thread_id, source) DO UPDATE SET delivery_key = ${HEARD}
      WHERE delivery_key IS NULL AND event = excluded.event
    `.pipe(Effect.asVoid, Effect.orDie);

  const missionsWithUpdates = sql<{ readonly mission_id: string }>`
    SELECT DISTINCT mission_id FROM mission_updates WHERE delivery_key IS NOT ${HEARD}
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.mission_id)),
    Effect.orDie,
  );

  const takeMissionUpdates = (missionId: string, lead: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* updateRows(missionId);
          const underWay = rows.filter((row) => row.delivery_key !== null);
          const replay = underWay[0];
          if (replay !== undefined && replay.delivery_lead === lead) {
            return {
              key: replay.delivery_key!,
              updates: underWay
                .filter((row) => row.delivery_key === replay.delivery_key)
                .map(toUpdate),
            };
          }
          yield* sql`
            UPDATE mission_updates SET delivery_key = NULL, delivery_lead = NULL
            WHERE mission_id = ${missionId} AND delivery_key IS NOT NULL
              AND delivery_key IS NOT ${HEARD}
          `;
          yield* keepLatestWaitingPerMemberPreferringJoins(missionId);
          const updates = (yield* updateRows(missionId)).map((row) => ({
            ...toUpdate(row),
            attempt: row.attempt,
          }));
          const key = deliveryKey(lead, updates);
          if (updates.length > 0) {
            yield* sql`
              UPDATE mission_updates SET delivery_key = ${key}, delivery_lead = ${lead}
              WHERE mission_id = ${missionId} AND delivery_key IS NOT ${HEARD}
            `;
          }
          return { key, updates: updates.map(({ attempt: _attempt, ...update }) => update) };
        }),
      )
      .pipe(Effect.orDie);

  const rekeyMissionUpdates = (missionId: string, key: string) =>
    sql`
      UPDATE mission_updates
      SET delivery_key = NULL, delivery_lead = NULL, attempt = attempt + 1
      WHERE mission_id = ${missionId} AND delivery_key = ${key}
    `.pipe(Effect.asVoid, Effect.orDie);

  const clearMissionUpdates = (
    missionId: string,
    key: string,
    held: ReadonlyArray<Pick<MissionUpdate, "environmentId" | "threadId" | "source">> = [],
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const update of held) {
            yield* sql`
              UPDATE mission_updates SET delivery_key = NULL, delivery_lead = NULL
              WHERE mission_id = ${missionId} AND delivery_key = ${key}
                AND environment_id = ${update.environmentId} AND thread_id = ${update.threadId}
                AND source = ${update.source}
            `;
          }
          yield* sql`
            DELETE FROM mission_updates WHERE mission_id = ${missionId} AND delivery_key = ${key}
          `;
        }),
      )
      .pipe(Effect.asVoid, Effect.orDie);

  const memberMark = (member: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) =>
    sql<{ readonly mark: string }>`
      SELECT mark FROM member_marks
      WHERE environment_id = ${member.environmentId} AND thread_id = ${member.threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.mark),
      Effect.orDie,
    );

  const setMemberMark = (
    member: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    mark: string,
  ) =>
    sql`
      INSERT OR REPLACE INTO member_marks (environment_id, thread_id, mark)
      VALUES (${member.environmentId}, ${member.threadId}, ${mark})
    `.pipe(Effect.asVoid, Effect.orDie);

  const ledBefore = (threadId: ThreadId) =>
    sql`SELECT 1 FROM former_leads WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.orDie,
    );

  const startJoin = Effect.fn("MissionStore.startJoin")(function* (
    thread: StartedThread,
    intentId: string,
  ) {
    const startedAt = yield* DateTime.now;
    const oldest = DateTime.formatIso(DateTime.subtract(startedAt, { days: STARTED_JOIN_DAYS }));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM started_joins WHERE started_at < ${oldest}`;
        const [known] = yield* sql<{ readonly released: number; readonly intent_id: string }>`
          SELECT released, intent_id FROM started_joins
          WHERE environment_id = ${thread.environmentId} AND thread_id = ${thread.threadId}
            AND mission_id = ${thread.missionId}
        `;
        if (known !== undefined) {
          return {
            state: known.released === 1 ? ("released" as const) : ("requested" as const),
            intentId: known.intent_id,
          };
        }
        yield* sql`
          INSERT INTO started_joins (environment_id, thread_id, mission_id, intent_id, started_at)
          VALUES (${thread.environmentId}, ${thread.threadId}, ${thread.missionId}, ${intentId},
            ${DateTime.formatIso(startedAt)})
        `;
        return { state: "first" as const, intentId };
      }),
    );
  }, Effect.orDie);

  const startedReleased = Effect.fn("MissionStore.startedReleased")(function* (
    thread: StartedThread,
  ) {
    yield* sql`
      UPDATE started_joins SET released = 1
      WHERE environment_id = ${thread.environmentId} AND thread_id = ${thread.threadId}
        AND mission_id = ${thread.missionId}
    `.pipe(Effect.orDie);
  });

  const numbersKnown = Effect.fn("MissionStore.numbersKnown")(function* (missionId: string) {
    const members = yield* sql<{
      readonly environment_id: string;
      readonly thread_id: string;
      readonly number: number;
    }>`SELECT environment_id, thread_id, number FROM member_numbers WHERE mission_id = ${missionId}`;
    const machines = yield* sql<{ readonly environment_id: string; readonly number: number }>`
      SELECT environment_id, number FROM machine_numbers
    `;
    return {
      member: new Map(
        members.map((row) => [
          numberKey({ environmentId: row.environment_id, threadId: row.thread_id }),
          row.number,
        ]),
      ),
      machine: new Map(
        machines.map((row) => [EnvironmentId.make(row.environment_id), row.number] as const),
      ),
    } satisfies Numbers;
  }, Effect.orDie);

  const numberMember = Effect.fn("MissionStore.numberMember")(function* (
    missionId: string,
    ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    remote: boolean,
  ) {
    yield* sql`
        INSERT OR IGNORE INTO member_numbers (mission_id, environment_id, thread_id, number)
        SELECT ${missionId}, ${ref.environmentId}, ${ref.threadId}, COALESCE(MAX(number), 0) + 1
        FROM member_numbers WHERE mission_id = ${missionId}
      `;
    if (!remote) return;
    yield* sql`
        INSERT OR IGNORE INTO machine_numbers (environment_id, number)
        SELECT ${ref.environmentId}, COALESCE(MAX(number), 1) + 1 FROM machine_numbers
      `;
  });

  const numbersOf = Effect.fn("MissionStore.numbersOf")(function* (
    missionId: string,
    members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }>,
    here: EnvironmentId,
  ) {
    const known = yield* numbersKnown(missionId);
    const unnumbered = members.filter(
      (ref) =>
        !known.member.has(numberKey(ref)) ||
        (ref.environmentId !== here && !known.machine.has(ref.environmentId)),
    );
    if (unnumbered.length === 0) return known;
    yield* sql.withTransaction(
      Effect.forEach(
        unnumbered,
        (ref) => numberMember(missionId, ref, ref.environmentId !== here),
        { discard: true },
      ),
    );
    return yield* numbersKnown(missionId);
  }, Effect.orDie);

  return MissionStore.of({
    setPrompt,
    addMissionUpdate,
    markMissionUpdateHeard,
    missionsWithUpdates,
    takeMissionUpdates,
    clearMissionUpdates,
    memberMark,
    setMemberMark,
    ledBefore,
    startJoin,
    startedReleased,
    forgetStartedJoin: Effect.fn("MissionStore.forgetStartedJoin")(function* (thread: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) {
      yield* sql`
        DELETE FROM started_joins
        WHERE environment_id = ${thread.environmentId} AND thread_id = ${thread.threadId}
      `.pipe(Effect.orDie);
    }),
    numbersOf,
    numbersKnown,
    rekeyMissionUpdates,
    refusePendingRelease: Effect.fn("MissionStore.refusePendingRelease")(function* (
      release: PendingRelease,
      refusal: string,
    ) {
      yield* addPendingRelease({ ...release, refusal });
    }),
    changes,
    missions,
    createMission,
    setLead,
    deleteMission,
    join,
    deletedMissionIds,
    tombstoneChecks,
    setTombstoneCheck,
    release,
    leave,
    renameMission,
    renameClaim,
    claim,
    claimsOf,
    allClaims,
    unsyncedTags,
    tagsSynced,
    pendingReleases,
    addPendingRelease,
    clearPendingRelease,
    pendingAdds,
    setPendingAdd,
    clearPendingAdd,
    knownClaims,
    setKnownClaims,
    settleAdd,
    forgetClaim,
    forgetThread,
  });
});

export const layerFromPath = (filename: string) =>
  Layer.effect(MissionStore, make).pipe(Layer.provide(NodeSqliteClient.layer({ filename })));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerFromPath(path.join(stateDir, MISSIONS_DATABASE_FILE));
  }),
);
