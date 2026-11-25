import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Migrator from "effect/sql/Migrator";
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
          [5, "AddLinkAndAge"],
          [6, "MissionTombstones"],
          [7, "MissionLeadPrompt"],
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

it.effect("upgrades a database an earlier build left, keeping a given-up add's machine", () =>
  withDatabase((filename) =>
    Effect.gen(function* () {
      // The database as the build before tombstones left it: five migrations, a Mission, and
      // an add to the laptop it gave up on.
      yield* Effect.provide(
        Effect.gen(function* () {
          const earlier = Object.fromEntries(
            Object.entries(MissionStore.MIGRATIONS).filter(([id]) => Number(id.split("_")[0]) <= 5),
          );
          yield* Migrator.make({})({ loader: Migrator.fromRecord(earlier) });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO missions (mission_id, name, lead_thread_id, created_at)
            VALUES ('m1', 'M1', ${lead}, '2026-01-01T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO claims
              (thread_id, mission_id, mission_name, role, owner, generation, claimed_at)
            VALUES (${lead}, 'm1', 'M1', 'lead', 'env-a', 'g1', '2026-01-01T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO pending_adds
              (environment_id, thread_id, mission_id, intent_id, refusal, link_id, added_at)
            VALUES ('env-laptop', ${member}, 'm1', 'i1',
              'This add waited more than 7 days for the thread''s machine.', 'link', '2026-01-01')
          `;
          // A claim last seen on the desk, and a release the box never answered.
          yield* sql`
            INSERT INTO known_claims
              (environment_id, thread_id, mission_id, mission_name, generation)
            VALUES ('env-desk', 'desk-thread', 'm1', 'M1', 'g-desk')
          `;
          yield* sql`
            INSERT INTO pending_releases (environment_id, thread_id, generation, mission_id)
            VALUES ('env-box', 'box-thread', 'g-box', 'm1')
          `;
        }),
        NodeSqliteClient.layer({ filename }),
      );
      yield* usingStore(filename, (store) =>
        Effect.gen(function* () {
          assert.equal((yield* store.pendingAdds)[0]?.refusal?.startsWith("This add waited"), true);
          // Both are forgotten, so only the upgrade's record still names those machines.
          for (const [environmentId, threadId] of [
            ["env-desk", "desk-thread"],
            ["env-box", "box-thread"],
          ] as const) {
            yield* store.forgetThread({
              environmentId: EnvironmentId.make(environmentId),
              threadId: ThreadId.make(threadId),
              missionId: "m1",
            });
          }
          yield* store.deleteMission({ missionId: "m1", lead, machines: [] });
          // The deleted Mission still asks the laptop, which its old add may have reached.
          assert.deepEqual(
            (yield* store.tombstoneChecks).map((check) => check.environmentId).toSorted(),
            ["env-box", "env-desk", "env-laptop"],
          );
          assert.isTrue((yield* store.deletedMissionIds).has("m1"));
          const again = yield* store.createMission(claimFor(lead, "m1", "g2")).pipe(Effect.flip);
          assert.include(again.message, "was deleted");
        }),
      );
    }),
  ),
);

it.effect("upgrades a version-6 database: its missions get an empty prompt that can be set", () =>
  withDatabase((filename) =>
    Effect.gen(function* () {
      yield* Effect.provide(
        Effect.gen(function* () {
          const earlier = Object.fromEntries(
            Object.entries(MissionStore.MIGRATIONS).filter(([id]) => Number(id.split("_")[0]) <= 6),
          );
          yield* Migrator.make({})({ loader: Migrator.fromRecord(earlier) });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO missions (mission_id, name, lead_thread_id, created_at)
            VALUES ('m1', 'M1', ${lead}, '2026-01-01T00:00:00.000Z')
          `;
        }),
        NodeSqliteClient.layer({ filename }),
      );
      yield* usingStore(filename, (store) =>
        Effect.gen(function* () {
          assert.deepEqual(
            (yield* store.missions).map((mission) => mission.prompt),
            [""],
          );
          yield* store.setPrompt({ missionId: "m1", prompt: "Ship the release." });
          const missing = yield* store
            .setPrompt({ missionId: "gone", prompt: "x" })
            .pipe(Effect.flip);
          assert.equal(missing.message, "That mission was not found.");
        }),
      );
      const reopened = yield* usingStore(filename, (store) => store.missions);
      assert.deepEqual(
        reopened.map((mission) => mission.prompt),
        ["Ship the release."],
      );
    }),
  ),
);

it.effect("keeps one untold update per member, across a reopen, until it is told", () =>
  withDatabase((filename) =>
    Effect.gen(function* () {
      const update = {
        missionId: "m1",
        environmentId: EnvironmentId.make("env-a"),
        threadId: member,
      };
      yield* usingStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.addMissionUpdate({ ...update, event: "pending-approval" });
          yield* store.addMissionUpdate({ ...update, event: "awaiting-input" });
        }),
      );
      yield* usingStore(filename, (store) =>
        Effect.gen(function* () {
          const told = yield* store.missionUpdates;
          assert.deepEqual(told, [{ ...update, event: "awaiting-input" }]);
          // A newer change arrives while the first is being told, so it stays.
          yield* store.addMissionUpdate({ ...update, event: "completed" });
          yield* store.clearMissionUpdates(told);
          assert.deepEqual(yield* store.missionUpdates, [{ ...update, event: "completed" }]);
        }),
      );
    }),
  ),
);
