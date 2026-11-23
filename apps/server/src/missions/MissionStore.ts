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
}

const now = Effect.map(DateTime.now, DateTime.formatIso);

export class MissionStore extends Context.Service<
  MissionStore,
  {
    /** Publishes after every change, so watchers read the list again. */
    readonly changes: PubSub.PubSub<void>;
    /** Every Mission, oldest first, each with its lead first. */
    readonly list: Effect.Effect<ReadonlyArray<Mission>>;
    /** The Mission a thread belongs to, if any. */
    readonly missionOf: (ref: ScopedThreadRef) => Effect.Effect<Mission | undefined>;
    /** False when the lead already belongs to a Mission; nothing is written then. */
    readonly create: (input: {
      readonly missionId: string;
      readonly name: string;
      readonly lead: ScopedThreadRef;
    }) => Effect.Effect<boolean>;
    /** False when the thread already belongs to a Mission. */
    readonly addMember: (missionId: string, ref: ScopedThreadRef) => Effect.Effect<boolean>;
    readonly removeMember: (missionId: string, ref: ScopedThreadRef) => Effect.Effect<void>;
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
        })),
    }));

  const list = Effect.gen(function* () {
    const missions = yield* sql<MissionRow>`
      SELECT mission_id, name, created_at FROM missions ORDER BY created_at, rowid
    `;
    const members = yield* sql<MemberRow>`
      SELECT mission_id, environment_id, thread_id, role, added_at FROM mission_members
      ORDER BY role = 'member', added_at, rowid
    `;
    return assemble(missions, members);
  }).pipe(Effect.orDie, Effect.withSpan("MissionStore.list"));

  const missionOf = Effect.fn("MissionStore.missionOf")(function* (ref: ScopedThreadRef) {
    const missions = yield* sql<MissionRow>`
      SELECT m.mission_id, m.name, m.created_at FROM missions m
      JOIN mission_members mm ON mm.mission_id = m.mission_id
      WHERE mm.environment_id = ${ref.environmentId} AND mm.thread_id = ${ref.threadId}
    `;
    const mission = missions[0];
    if (mission === undefined) return undefined;
    const members = yield* sql<MemberRow>`
      SELECT mission_id, environment_id, thread_id, role, added_at FROM mission_members
      WHERE mission_id = ${mission.mission_id}
      ORDER BY role = 'member', added_at, rowid
    `;
    return assemble([mission], members)[0];
  }, Effect.orDie);

  const insertMember = (missionId: string, ref: ScopedThreadRef, role: MissionMember["role"]) =>
    Effect.flatMap(
      now,
      (addedAt) => sql<{ readonly thread_id: string }>`
        INSERT INTO mission_members (environment_id, thread_id, mission_id, role, added_at)
        VALUES (${ref.environmentId}, ${ref.threadId}, ${missionId}, ${role}, ${addedAt})
        ON CONFLICT DO NOTHING
        RETURNING thread_id
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const create = Effect.fn("MissionStore.create")(function* (input: {
    readonly missionId: string;
    readonly name: string;
    readonly lead: ScopedThreadRef;
  }) {
    const createdAt = yield* now;
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO missions (mission_id, name, created_at)
          VALUES (${input.missionId}, ${input.name}, ${createdAt})
        `;
          const added = yield* insertMember(input.missionId, input.lead, "lead");
          // Rolls the Mission back with the refused lead.
          if (!added) return yield* Effect.fail("lead-taken" as const);
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
    const added = yield* insertMember(missionId, ref, "member");
    if (added) yield* changed;
    return added;
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

  return MissionStore.of({ changes, list, missionOf, create, addMember, removeMember });
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
