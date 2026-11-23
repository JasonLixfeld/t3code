import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as MissionStore from "./MissionStore.ts";

const ref = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
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
      yield* usingStore(filename, (store) =>
        store.create({ missionId: "m1", name: "Ship it", lead: ref("env-a", "lead") }),
      );
      const reopened = yield* usingStore(filename, (store) => store.list);
      assert.deepEqual(
        reopened.map((mission) => mission.name),
        ["Ship it"],
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
        [[1, "Missions"]],
      );
    }),
  ),
);

it.effect("lists the lead first and refuses a thread that is already in a mission", () =>
  withDatabase((filename) =>
    usingStore(filename, (store) =>
      Effect.gen(function* () {
        const lead = ref("env-a", "lead");
        const member = ref("env-b", "member");
        assert.isTrue(yield* store.create({ missionId: "m1", name: "One", lead }));
        assert.isTrue(yield* store.addMember("m1", member));
        assert.isTrue(
          yield* store.create({ missionId: "m2", name: "Two", lead: ref("env-a", "other") }),
        );

        assert.isFalse(yield* store.addMember("m2", member));
        assert.isFalse(yield* store.create({ missionId: "m3", name: "Three", lead: member }));
        const missions = yield* store.list;
        assert.deepEqual(
          missions.map((mission) => mission.missionId),
          ["m1", "m2"],
        );
        assert.deepEqual(
          missions[0]!.members.map((entry) => [entry.ref.threadId, entry.role]),
          [
            ["lead", "lead"],
            ["member", "member"],
          ],
        );
        assert.equal((yield* store.missionOf(member))?.missionId, "m1");
      }),
    ),
  ),
);

it.effect("releasing a member frees it, and the lead stays", () =>
  withDatabase((filename) =>
    usingStore(filename, (store) =>
      Effect.gen(function* () {
        const lead = ref("env-a", "lead");
        const member = ref("env-b", "member");
        yield* store.create({ missionId: "m1", name: "One", lead });
        yield* store.addMember("m1", member);

        yield* store.removeMember("m1", member);
        yield* store.removeMember("m1", lead);
        assert.isUndefined(yield* store.missionOf(member));
        assert.equal((yield* store.missionOf(lead))?.missionId, "m1");
        assert.isTrue(yield* store.addMember("m1", member));
      }),
    ),
  ),
);
