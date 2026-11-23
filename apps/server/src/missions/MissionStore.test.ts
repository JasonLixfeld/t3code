import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

import * as MissionStore from "./MissionStore.ts";

const lead = ThreadId.make("lead");
const member = ThreadId.make("member");
const claimFor = (threadId: ThreadId, missionId: string, generation: string) => ({
  threadId,
  missionId,
  name: missionId.toUpperCase(),
  owner: "env-a",
  generation,
});

const withDatabase = <A, E>(use: (filename: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-store-" });
    return yield* use(path.join(directory, MissionStore.MISSIONS_DATABASE_FILE));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const usingStore = <A, E>(
  filename: string,
  use: (store: MissionStore.MissionStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(MissionStore.MissionStore, use).pipe(
    Effect.provide(MissionStore.layerFromPath(filename)),
  );

it.effect("keeps its own migration history and reopens without migrating again", () =>
  withDatabase((filename) =>
    Effect.gen(function* () {
      yield* usingStore(filename, (store) => store.createMission(claimFor(lead, "m1", "g1")));
      const reopened = yield* usingStore(filename, (store) => store.missions);
      assert.deepEqual(
        reopened.map((mission) => mission.name),
        ["M1"],
      );
      const recorded = yield* Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`SELECT migration_id, name FROM effect_sql_migrations`;
        }),
        NodeSqliteClient.layer({ filename }),
      );
      assert.deepEqual(
        recorded.map((row) => [row.migration_id, row.name]),
        [
          [1, "Missions"],
          [2, "LastKnown"],
          [3, "PendingAdds"],
          [4, "AddIntents"],
        ],
      );
    }),
  ),
);

it.effect(
  "starting a mission adds it with its lead's claim, a retry returns it, and a refusal changes nothing",
  () =>
    withDatabase((filename) =>
      usingStore(filename, (store) =>
        Effect.gen(function* () {
          const first = yield* store.createMission(claimFor(lead, "m1", "g1"));
          assert.deepEqual(yield* store.claim(lead), {
            threadId: lead,
            missionId: "m1",
            name: "M1",
            role: "lead",
            generation: "g1",
          });
          assert.deepEqual(yield* store.createMission(claimFor(lead, "m1", "g2")), first);
          assert.equal((yield* store.claim(lead))?.generation, "g1");

          const memberClaim = yield* store.join(claimFor(member, "m1", "g3"));
          const sameId = yield* store.createMission(claimFor(member, "m1", "g4")).pipe(Effect.flip);
          assert.equal(sameId.message, "Another mission already uses this id.");
          const leadTaken = yield* store
            .createMission(claimFor(lead, "m2", "g5"))
            .pipe(Effect.flip);
          assert.include(leadTaken.message, 'already in the mission "M1"');
          yield* store.createMission(claimFor(member, "m3", "g6")).pipe(Effect.flip);

          assert.deepEqual(yield* store.missions, [first]);
          assert.deepEqual(yield* store.claim(member), memberClaim);
        }),
      ),
    ),
);

it.effect("a release drops only the member claim that its generation, mission and owner name", () =>
  withDatabase((filename) =>
    usingStore(filename, (store) =>
      Effect.gen(function* () {
        yield* store.createMission(claimFor(lead, "m1", "g1"));
        const held = yield* store.join(claimFor(member, "m1", "g2"));
        const release = { threadId: member, missionId: "m1", owner: "env-a", generation: "g2" };
        yield* store.release({ ...release, generation: "g0" });
        yield* store.release({ ...release, missionId: "m2" });
        yield* store.release({ ...release, owner: "link:other" });
        yield* store.release({ ...release, threadId: lead, generation: "g1" });
        const both: ReadonlyArray<unknown> = [yield* store.claim(lead), held];
        assert.deepEqual(yield* store.claimsOf("env-a"), both);

        yield* store.release(release);
        assert.isUndefined(yield* store.claim(member));
        assert.equal((yield* store.leave(lead).pipe(Effect.flip)).message.includes("lead"), true);
      }),
    ),
  ),
);

it.effect(
  "the production store writes missions.sqlite in the state folder, not the main database",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-home-" });
      const config = ServerConfig.layerTest(process.cwd(), baseDir);
      const { stateDir, dbPath } = yield* Effect.gen(function* () {
        yield* Effect.flatMap(MissionStore.MissionStore, (store) =>
          store.createMission(claimFor(lead, "m1", "g1")),
        ).pipe(Effect.provide(MissionStore.layer));
        return yield* ServerConfig.ServerConfig;
      }).pipe(Effect.provide(config));

      const missionsFile = path.join(stateDir, "missions.sqlite");
      assert.notEqual(missionsFile, dbPath);
      assert.isTrue(yield* fileSystem.exists(missionsFile));
      const tablesIn = (filename: string) =>
        Effect.provide(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{ readonly name: string }>`SELECT name FROM sqlite_schema WHERE type = 'table'`,
          ),
          NodeSqliteClient.layer({ filename }),
        ).pipe(Effect.map((rows) => rows.map((row) => row.name)));
      assert.include(yield* tablesIn(missionsFile), "missions");
      if (yield* fileSystem.exists(dbPath)) {
        assert.notInclude(yield* tablesIn(dbPath), "missions");
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
