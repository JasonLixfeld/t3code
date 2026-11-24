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

/**
 * Missions keep their own database and migration history. The main database's migrator skips
 * every id up to the highest recorded one, so a fork migration there would collide with
 * upstream's next id after a rebase.
 */
export const MISSIONS_DATABASE_FILE = "missions.sqlite";

const migrations = Migrator.fromRecord({
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
    // The primary key is the thread, so a thread here belongs to at most one Mission.
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
    // The machines a lead asks are now those with a known claim, a pending add or a pending release.
    yield* sql`DROP TABLE known_machines`;
  }),
  "4_AddIntents": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // One row per thread and Mission now, so an add to one Mission never replaces another's.
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
});

interface MissionRow {
  readonly mission_id: string;
  readonly name: string;
  readonly lead_thread_id: string;
  readonly created_at: string;
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

/** A Mission led by a thread on this machine. */
export interface MissionRecord {
  readonly missionId: string;
  readonly name: string;
  readonly leadThreadId: ThreadId;
  readonly createdAt: string;
}

/** A thread on this machine held by a Mission. `generation` names the join that made the claim. */
export interface MissionClaim {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  readonly role: "lead" | "member";
  readonly generation: string;
}

/**
 * An add this lead means to make, written before its join is sent. `intentId` names this one add
 * in every copy of the join. `refusal` is why the member's machine turned it down, once it
 * answered; the row then stays until the user dismisses it.
 */
export interface PendingAdd {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly intentId: string;
  /** The link to the thread's machine when the add was made. A link made again is another one. */
  readonly linkId: string;
  readonly addedAt: string;
  readonly refusal: string | null;
}

type AddKey = Pick<PendingAdd, "environmentId" | "threadId" | "missionId">;

/** How long a member's machine remembers an add whose claim was dropped. */
const SPENT_INTENT_DAYS = 30;

/** A release this lead sent that the member's machine has not answered yet. */
export interface PendingRelease {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly missionId: string;
}

interface ClaimInput {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  readonly owner: string;
  readonly generation: string;
  /** The lead's add this join belongs to. Absent for a lead's own claim and a join made here. */
  readonly intentId?: string | undefined;
}

const toMission = (row: MissionRow): MissionRecord => ({
  missionId: row.mission_id,
  name: row.name,
  leadThreadId: ThreadId.make(row.lead_thread_id),
  createdAt: row.created_at,
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
    `This thread is already in the mission "${held.mission_name}". Release it from that mission first.`,
  );

const now = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Every claim change also lists the thread in `unsynced_tags`, in the same transaction, until its
 * tags are written. The claim methods are called only under MissionClaims' per-thread lock.
 */
export class MissionStore extends Context.Service<
  MissionStore,
  {
    /** Publishes after every change, so watchers read again. */
    readonly changes: PubSub.PubSub<void>;
    /** The Missions led here, oldest first. */
    readonly missions: Effect.Effect<ReadonlyArray<MissionRecord>>;
    /**
     * Adds the Mission and its lead thread's claim together, or neither. Refuses a thread that
     * has any claim. Asking again with the same id and lead returns the Mission it already made.
     */
    readonly createMission: (lead: ClaimInput) => Effect.Effect<MissionRecord, MissionError>;
    /**
     * Makes a thread the Mission's lead, and drops the old lead's claim, both or neither. A
     * member of this Mission here keeps its claim, which becomes the lead's. Refuses a thread
     * any other Mission or owner holds, and refuses when the lead is no longer `previous`, since
     * only `previous` is locked.
     */
    readonly setLead: (
      lead: ClaimInput & { readonly previous: ThreadId },
    ) => Effect.Effect<MissionRecord, MissionError>;
    /**
     * Ends a Mission with no members, dropping its lead's claim with it. Refuses while any member
     * claim, add or release is known, and when the lead is no longer `lead`, the one locked.
     */
    readonly deleteMission: (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
    }) => Effect.Effect<void, MissionError>;
    /**
     * The claim this owner already holds for this Mission, or a new one. Refuses any other claim.
     * `intent-spent`: the claim this add made was dropped since, so the add may not make another.
     */
    readonly join: (
      input: ClaimInput,
    ) => Effect.Effect<MissionClaim | "intent-spent", MissionError>;
    /** Drops the member claim that one join made, if this owner still holds it. */
    readonly release: (input: Omit<ClaimInput, "name">) => Effect.Effect<void>;
    /** Drops the thread's claim, whoever holds it. Refuses a lead's claim. */
    readonly leave: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /**
     * Names a Mission led here again, from the title of `lead`, unless its lead changed since.
     * Answers the name it has now. Its claims follow through `renameClaims`.
     */
    readonly renameMission: (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
      readonly name: string;
    }) => Effect.Effect<string>;
    /**
     * Gives this owner's claim on one thread the Mission's new name, and marks its tags unsynced
     * with it. Answers whether it changed. Called only under that thread's lock.
     */
    readonly renameClaim: (input: {
      readonly threadId: ThreadId;
      readonly owner: string;
      readonly missionId: string;
      readonly name: string;
    }) => Effect.Effect<boolean>;
    readonly claim: (threadId: ThreadId) => Effect.Effect<MissionClaim | undefined>;
    readonly claimsOf: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
    readonly allClaims: Effect.Effect<ReadonlyArray<MissionClaim>>;
    /** Threads whose claim changed since their tags were last written. */
    readonly unsyncedTags: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly tagsSynced: (threadId: ThreadId) => Effect.Effect<void>;
    readonly pendingReleases: Effect.Effect<ReadonlyArray<PendingRelease>>;
    readonly addPendingRelease: (release: PendingRelease) => Effect.Effect<void>;
    readonly clearPendingRelease: (
      release: Omit<PendingRelease, "missionId">,
    ) => Effect.Effect<void>;
    readonly pendingAdds: Effect.Effect<ReadonlyArray<PendingAdd>>;
    /** Records the add, or what became of it. One row per thread and Mission. */
    readonly setPendingAdd: (add: PendingAdd) => Effect.Effect<void>;
    readonly clearPendingAdd: (add: AddKey) => Effect.Effect<void>;
    /** Replaces a pending add with the claim its join made, both or neither. */
    readonly settleAdd: (add: AddKey, claim: MissionClaim) => Effect.Effect<void>;
    /**
     * What each linked machine last said it holds for this lead. A copy to show while a machine
     * is away: only that machine's answer is the truth.
     */
    readonly knownClaims: Effect.Effect<ReadonlyMap<EnvironmentId, ReadonlyArray<MissionClaim>>>;
    /** Replaces what a machine last said. */
    readonly setKnownClaims: (
      environmentId: EnvironmentId,
      claims: ReadonlyArray<MissionClaim>,
    ) => Effect.Effect<void>;
    readonly forgetClaim: (release: Omit<PendingRelease, "missionId">) => Effect.Effect<void>;
    /** Drops what this lead waits for and last knew about one thread, in one Mission only. */
    readonly forgetThread: (thread: AddKey) => Effect.Effect<void>;
  }
>()("t3/missions/MissionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* Migrator.make({})({ loader: migrations });
  const changes = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(changes, undefined);

  /** One transaction. A refusal is returned out of it, so it has written nothing. */
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

  /** The add that made this claim may not make another. Old entries go, so the table stays small. */
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
    SELECT mission_id, name, lead_thread_id, created_at FROM missions ORDER BY created_at, rowid
  `.pipe(
    Effect.map((rows) => rows.map(toMission)),
    Effect.orDie,
    Effect.withSpan("MissionStore.missions"),
  );

  const createMission = Effect.fn("MissionStore.createMission")(function* (lead: ClaimInput) {
    const createdAt = yield* now;
    return yield* change(
      Effect.gen(function* () {
        const existing = yield* sql<MissionRow>`
          SELECT mission_id, name, lead_thread_id, created_at FROM missions
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
          INSERT INTO missions (mission_id, name, lead_thread_id, created_at)
          VALUES (${lead.missionId}, ${lead.name}, ${lead.threadId}, ${createdAt})
        `;
        yield* insertClaim(lead, "lead", createdAt);
        return toMission({
          mission_id: lead.missionId,
          name: lead.name,
          lead_thread_id: lead.threadId,
          created_at: createdAt,
        });
      }),
    );
  });

  const deleteMission = Effect.fn("MissionStore.deleteMission")(function* (input: {
    readonly missionId: string;
    readonly lead: ThreadId;
  }) {
    return yield* change(
      Effect.gen(function* () {
        const [mission] = yield* sql<MissionRow>`
          SELECT mission_id, name, lead_thread_id, created_at FROM missions
          WHERE mission_id = ${input.missionId}
        `;
        if (mission === undefined) return refuse("That mission was not found.");
        if (mission.lead_thread_id !== input.lead) {
          return new MissionError({
            message: "This mission already has a new lead.",
            reason: "lead-changed",
          });
        }
        const [held] = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM claims WHERE mission_id = ${input.missionId} AND role = 'member'
          UNION ALL SELECT 1 FROM known_claims WHERE mission_id = ${input.missionId}
          UNION ALL SELECT 1 FROM pending_adds
            WHERE mission_id = ${input.missionId} AND refusal IS NULL
          UNION ALL SELECT 1 FROM pending_releases WHERE mission_id = ${input.missionId}
          LIMIT 1
        `;
        if (held !== undefined) {
          return refuse("Release this mission's threads before deleting it.");
        }
        yield* sql`DELETE FROM pending_adds WHERE mission_id = ${input.missionId}`;
        yield* sql`
          DELETE FROM claims WHERE thread_id = ${input.lead} AND mission_id = ${input.missionId}
        `;
        yield* sql`DELETE FROM missions WHERE mission_id = ${input.missionId}`;
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
          SELECT mission_id, name, lead_thread_id, created_at FROM missions
          WHERE mission_id = ${lead.missionId}
        `;
        if (mission === undefined) return refuse("That mission was not found.");
        const previous = ThreadId.make(mission.lead_thread_id);
        // Asked again after it took effect, as a retry whose answer was lost is.
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
          UPDATE missions SET lead_thread_id = ${lead.threadId}, name = ${lead.name}
          WHERE mission_id = ${lead.missionId}
        `;
        return toMission({ ...mission, lead_thread_id: lead.threadId, name: lead.name });
      }),
    );
  });

  const join = Effect.fn("MissionStore.join")(function* (input: ClaimInput) {
    const claimedAt = yield* now;
    return yield* change(
      Effect.gen(function* () {
        const { intentId } = input;
        if (intentId !== undefined) {
          // Whoever sends it: a lead that was linked again is another owner with the same add.
          const spent = yield* sql`
            SELECT 1 FROM spent_intents
            WHERE mission_id = ${input.missionId} AND intent_id = ${intentId}
          `;
          if (spent.length > 0) return "intent-spent" as const;
        }
        const held = yield* claimRow(input.threadId);
        if (held === undefined) return yield* insertClaim(input, "member", claimedAt);
        if (held.owner !== input.owner || held.mission_id !== input.missionId) {
          return heldElsewhere(held);
        }
        // A later add of a thread already in takes the claim over, so a drop spends both adds.
        if (intentId !== undefined && held.intent_id !== intentId) {
          yield* spendIntent(held);
          yield* sql`UPDATE claims SET intent_id = ${intentId} WHERE thread_id = ${input.threadId}`;
        }
        return toClaim(held);
      }),
    );
  });

  const release = Effect.fn("MissionStore.release")(function* (input: Omit<ClaimInput, "name">) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const held = yield* claimRow(input.threadId);
        if (
          held === undefined ||
          held.mission_id !== input.missionId ||
          held.generation !== input.generation ||
          held.owner !== input.owner ||
          held.role !== "member"
        ) {
          return;
        }
        yield* spendIntent(held);
        yield* sql`DELETE FROM claims WHERE thread_id = ${input.threadId}`;
        yield* markUnsynced(input.threadId);
      }),
    );
    yield* changed;
  }, Effect.orDie);

  const leave = Effect.fn("MissionStore.leave")(function* (threadId: ThreadId) {
    yield* change(
      Effect.gen(function* () {
        const held = yield* claimRow(threadId);
        if (held === undefined) return refuse("This thread is not in a mission.");
        if (held.role === "lead") {
          return refuse("A mission keeps its lead thread, so the lead cannot be released.");
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

  const pendingReleases = sql<PendingReleaseRow>`
    SELECT environment_id, thread_id, generation, mission_id FROM pending_releases ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): PendingRelease => ({
        environmentId: EnvironmentId.make(row.environment_id),
        threadId: ThreadId.make(row.thread_id),
        generation: row.generation,
        missionId: row.mission_id,
      })),
    ),
    Effect.orDie,
  );

  const addPendingRelease = (pending: PendingRelease) =>
    sql`
      INSERT OR IGNORE INTO pending_releases (environment_id, thread_id, generation, mission_id)
      VALUES (${pending.environmentId}, ${pending.threadId}, ${pending.generation},
        ${pending.missionId})
    `.pipe(Effect.andThen(changed), Effect.asVoid, Effect.orDie);

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
  }>`
    SELECT environment_id, thread_id, mission_id, intent_id, link_id, added_at, refusal
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
      })),
    ),
    Effect.orDie,
  );

  const setPendingAdd = (add: PendingAdd) =>
    sql`
      INSERT OR REPLACE INTO pending_adds
        (environment_id, thread_id, mission_id, intent_id, link_id, added_at, refusal)
      VALUES (${add.environmentId}, ${add.threadId}, ${add.missionId}, ${add.intentId},
        ${add.linkId}, ${add.addedAt}, ${add.refusal})
    `.pipe(Effect.andThen(changed), Effect.asVoid, Effect.orDie);

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
    `;

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
  ) {
    yield* sql.withTransaction(
      deletePendingAdd(add).pipe(Effect.andThen(insertKnownClaim(add.environmentId, held))),
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

  return MissionStore.of({
    changes,
    missions,
    createMission,
    setLead,
    deleteMission,
    join,
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
