import {
  EnvironmentId,
  type Mission,
  type MissionMember,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

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
        created_at TEXT NOT NULL
      )
    `;
    // The primary key is the thread, so a thread belongs to at most one Mission.
    yield* sql`
      CREATE TABLE mission_members (
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions (mission_id),
        role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
        added_at TEXT NOT NULL,
        PRIMARY KEY (environment_id, thread_id)
      )
    `;
    yield* sql`CREATE INDEX mission_members_by_mission ON mission_members (mission_id, added_at)`;
  }),
  "2_Claims": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The member's machine holds the one authority on which Mission a thread here belongs to.
    yield* sql`
      CREATE TABLE mission_claims (
        thread_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        mission_name TEXT NOT NULL,
        owner TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX mission_claims_by_owner ON mission_claims (owner)`;
    yield* sql`
      ALTER TABLE mission_members ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'release-pending', 'released'))
    `;
  }),
});

interface MissionRow {
  readonly mission_id: string;
  readonly name: string;
  readonly created_at: string;
}
interface MemberRow {
  readonly mission_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly role: MissionMember["role"];
  readonly added_at: string;
  readonly state: MissionMember["state"];
}
interface ClaimRow {
  readonly thread_id: string;
  readonly mission_id: string;
  readonly mission_name: string;
  readonly owner: string;
  readonly claim_id: string;
}

/** A thread on this machine held by a Mission. `claimId` names the join that made it. */
export interface MissionClaim {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  readonly claimId: string;
}

const toClaim = (row: ClaimRow): MissionClaim => ({
  threadId: ThreadId.make(row.thread_id),
  missionId: row.mission_id,
  name: row.mission_name,
  claimId: row.claim_id,
});

const now = Effect.map(DateTime.now, DateTime.formatIso);

export class MissionStore extends Context.Service<
  MissionStore,
  {
    /** Publishes after every change to the lead's records, so watchers read the list again. */
    readonly changes: PubSub.PubSub<void>;
    /** Every Mission, oldest first, each with its lead first. */
    readonly list: Effect.Effect<ReadonlyArray<Mission>>;
    /** The Mission a thread is an active member of, if any. */
    readonly missionOf: (ref: ScopedThreadRef) => Effect.Effect<Mission | undefined>;
    /** True when the Mission now exists with this lead, including when it already did. */
    readonly create: (input: {
      readonly missionId: string;
      readonly name: string;
      readonly lead: ScopedThreadRef;
    }) => Effect.Effect<boolean>;
    /** True when the thread is now an active member of the Mission, including when it already was. */
    readonly addMember: (missionId: string, ref: ScopedThreadRef) => Effect.Effect<boolean>;
    readonly setMemberState: (
      missionId: string,
      ref: ScopedThreadRef,
      state: MissionMember["state"],
    ) => Effect.Effect<void>;
    readonly removeMember: (missionId: string, ref: ScopedThreadRef) => Effect.Effect<void>;
    /** The claim now holding the thread: the one asked for, or one that already held it. */
    readonly claim: (input: {
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly name: string;
      readonly owner: string;
      readonly claimId: string;
    }) => Effect.Effect<{ readonly claim: MissionClaim; readonly owner: string }>;
    /** Drops and returns the thread's claim, only when `owner` holds it and the Mission or join matches. */
    readonly dropClaim: (
      threadId: ThreadId,
      match: {
        readonly owner: string;
        readonly missionId?: string | undefined;
        readonly claimId?: string | undefined;
      },
    ) => Effect.Effect<MissionClaim | "absent" | "not-yours">;
    readonly claimsOf: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
    /** Every claim on threads here, with the owner that holds it. */
    readonly allClaims: Effect.Effect<ReadonlyArray<MissionClaim & { readonly owner: string }>>;
  }
>()("t3/missions/MissionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* Migrator.make({})({ loader: migrations });
  const changes = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(changes, undefined);

  const assemble = (missions: ReadonlyArray<MissionRow>, members: ReadonlyArray<MemberRow>) =>
    missions.map((row): Mission => ({
      missionId: row.mission_id,
      name: row.name,
      createdAt: row.created_at,
      members: members
        .filter((member) => member.mission_id === row.mission_id)
        .map((member) => ({
          ref: {
            environmentId: EnvironmentId.make(member.environment_id),
            threadId: ThreadId.make(member.thread_id),
          },
          role: member.role,
          addedAt: member.added_at,
          state: member.state,
        })),
    }));

  const list = Effect.gen(function* () {
    const missions = yield* sql<MissionRow>`
      SELECT mission_id, name, created_at FROM missions ORDER BY created_at, rowid
    `;
    const members = yield* sql<MemberRow>`
      SELECT mission_id, environment_id, thread_id, role, added_at, state FROM mission_members
      ORDER BY role = 'member', added_at, rowid
    `;
    return assemble(missions, members);
  }).pipe(Effect.orDie, Effect.withSpan("MissionStore.list"));

  const missionOf = Effect.fn("MissionStore.missionOf")(function* (ref: ScopedThreadRef) {
    const rows = yield* sql<{ readonly mission_id: string }>`
      SELECT mission_id FROM mission_members
      WHERE environment_id = ${ref.environmentId} AND thread_id = ${ref.threadId}
        AND state = 'active'
    `;
    const missionId = rows[0]?.mission_id;
    return missionId === undefined
      ? undefined
      : (yield* list).find((mission) => mission.missionId === missionId);
  }, Effect.orDie);

  // A row that is not active gives way, so a released thread can join again or elsewhere.
  const upsertMember = Effect.fn("MissionStore.upsertMember")(function* (
    missionId: string,
    ref: ScopedThreadRef,
    role: MissionMember["role"],
  ) {
    const addedAt = yield* now;
    yield* sql`
        INSERT INTO mission_members (environment_id, thread_id, mission_id, role, added_at, state)
        VALUES (${ref.environmentId}, ${ref.threadId}, ${missionId}, ${role}, ${addedAt}, 'active')
        ON CONFLICT (environment_id, thread_id) DO UPDATE SET
          mission_id = excluded.mission_id, role = excluded.role,
          added_at = excluded.added_at, state = 'active'
        WHERE mission_members.state != 'active'
      `;
    const held = yield* sql<{ readonly mission_id: string }>`
        SELECT mission_id FROM mission_members
        WHERE environment_id = ${ref.environmentId} AND thread_id = ${ref.threadId}
      `;
    return held[0]?.mission_id === missionId;
  });

  const create = Effect.fn("MissionStore.create")(function* (input: {
    readonly missionId: string;
    readonly name: string;
    readonly lead: ScopedThreadRef;
  }) {
    const createdAt = yield* now;
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const leads = yield* sql<{ readonly environment_id: string; readonly thread_id: string }>`
            SELECT environment_id, thread_id FROM mission_members
            WHERE mission_id = ${input.missionId} AND role = 'lead'
          `;
          const existing = leads[0];
          if (existing !== undefined) {
            return (
              existing.environment_id === input.lead.environmentId &&
              existing.thread_id === input.lead.threadId
            );
          }
          yield* sql`
            INSERT INTO missions (mission_id, name, created_at)
            VALUES (${input.missionId}, ${input.name}, ${createdAt})
          `;
          // Rolls the Mission back with the refused lead.
          if (!(yield* upsertMember(input.missionId, input.lead, "lead"))) {
            return yield* Effect.fail("lead-taken" as const);
          }
          return true;
        }),
      )
      .pipe(
        Effect.catchIf(
          (error) => error === "lead-taken",
          () => Effect.succeed(false),
        ),
      );
    if (created) yield* changed;
    return created;
  }, Effect.orDie);

  const addMember = Effect.fn("MissionStore.addMember")(function* (
    missionId: string,
    ref: ScopedThreadRef,
  ) {
    const added = yield* sql.withTransaction(upsertMember(missionId, ref, "member"));
    if (added) yield* changed;
    return added;
  }, Effect.orDie);

  const setMemberState = Effect.fn("MissionStore.setMemberState")(function* (
    missionId: string,
    ref: ScopedThreadRef,
    state: MissionMember["state"],
  ) {
    yield* sql`
      UPDATE mission_members SET state = ${state}
      WHERE mission_id = ${missionId} AND environment_id = ${ref.environmentId}
        AND thread_id = ${ref.threadId} AND role = 'member'
    `;
    yield* changed;
  }, Effect.orDie);

  const removeMember = Effect.fn("MissionStore.removeMember")(function* (
    missionId: string,
    ref: ScopedThreadRef,
  ) {
    yield* sql`
      DELETE FROM mission_members
      WHERE mission_id = ${missionId} AND environment_id = ${ref.environmentId}
        AND thread_id = ${ref.threadId} AND role = 'member'
    `;
    yield* changed;
  }, Effect.orDie);

  const claimRow = (threadId: ThreadId) =>
    sql<ClaimRow>`
      SELECT thread_id, mission_id, mission_name, owner, claim_id FROM mission_claims
      WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]));

  const claim = Effect.fn("MissionStore.claim")(function* (input: {
    readonly threadId: ThreadId;
    readonly missionId: string;
    readonly name: string;
    readonly owner: string;
    readonly claimId: string;
  }) {
    const claimedAt = yield* now;
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* claimRow(input.threadId);
        if (existing !== undefined) return existing;
        yield* sql`
          INSERT INTO mission_claims
            (thread_id, mission_id, mission_name, owner, claim_id, claimed_at)
          VALUES (${input.threadId}, ${input.missionId}, ${input.name}, ${input.owner},
            ${input.claimId}, ${claimedAt})
        `;
        return (yield* claimRow(input.threadId))!;
      }),
    );
    if (row.claim_id === input.claimId) yield* changed;
    return { claim: toClaim(row), owner: row.owner };
  }, Effect.orDie);

  const dropClaim = Effect.fn("MissionStore.dropClaim")(function* (
    threadId: ThreadId,
    match: {
      readonly owner: string;
      readonly missionId?: string | undefined;
      readonly claimId?: string | undefined;
    },
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* claimRow(threadId);
          if (row === undefined) return "absent" as const;
          if (
            row.owner !== match.owner ||
            (match.missionId !== undefined && row.mission_id !== match.missionId) ||
            (match.claimId !== undefined && row.claim_id !== match.claimId)
          ) {
            return "not-yours" as const;
          }
          yield* sql`DELETE FROM mission_claims WHERE thread_id = ${threadId}`;
          return toClaim(row);
        }),
      )
      .pipe(Effect.tap((dropped) => (typeof dropped === "string" ? Effect.void : changed)));
  }, Effect.orDie);

  const claimsOf = Effect.fn("MissionStore.claimsOf")(function* (owner: string) {
    const rows = yield* sql<ClaimRow>`
      SELECT thread_id, mission_id, mission_name, owner, claim_id FROM mission_claims
      WHERE owner = ${owner} ORDER BY claimed_at, rowid
    `;
    return rows.map(toClaim);
  }, Effect.orDie);

  const allClaims = sql<ClaimRow>`
    SELECT thread_id, mission_id, mission_name, owner, claim_id FROM mission_claims
    ORDER BY claimed_at, rowid
  `.pipe(
    Effect.map((rows) => rows.map((row) => ({ ...toClaim(row), owner: row.owner }))),
    Effect.orDie,
  );

  return MissionStore.of({
    changes,
    list,
    missionOf,
    create,
    addMember,
    setMemberState,
    removeMember,
    claim,
    dropClaim,
    claimsOf,
    allClaims,
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
