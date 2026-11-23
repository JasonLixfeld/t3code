import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  EnvironmentId,
  OrchestratorMcpFailure,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as MissionStore from "./MissionStore.ts";
import * as Missions from "./Missions.ts";
import { planMissionTags } from "./MissionTags.ts";

const HERE = EnvironmentId.make("env-here");
const LAPTOP = EnvironmentId.make("env-laptop");
const FENCED = EnvironmentId.make("env-fenced");
const OFFLINE = EnvironmentId.make("env-offline");
const LINKS: ReadonlyArray<{ id: EnvironmentId; label: string; access: AuthMcpClientAccess }> = [
  { id: LAPTOP, label: "Laptop", access: "full-access" },
  { id: FENCED, label: "Fenced box", access: "auto" },
  { id: OFFLINE, label: "Sleeping box", access: "full-access" },
];

const ref = (environmentId: EnvironmentId, threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});
const keyOf = (thread: ScopedThreadRef) => `${thread.environmentId}/${thread.threadId}`;

/** Every machine's threads and their tags, and the calls that reached a linked machine. */
const makeWorld = (threads: ReadonlyArray<[ScopedThreadRef, ReadonlyArray<string>]>) => {
  const tags = new Map(threads.map(([thread, initial]) => [keyOf(thread), [...initial]]));
  const peerCalls: Array<EnvironmentId> = [];
  const offline = new Set([OFFLINE]);
  /** Machines that answer every change except taking a tag back off. */
  const refuseUndo = new Set<EnvironmentId>();
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.sync(
          () =>
            (tags.has(keyOf(ref(HERE, threadId)))
              ? { id: threadId, deletedAt: null, tags: tags.get(keyOf(ref(HERE, threadId))) }
              : null) as never,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "thread.tag.set") throw new Error(`unexpected ${command.type}`);
          const key = keyOf(ref(HERE, command.threadId));
          const current = tags.get(key) ?? [];
          tags.set(
            key,
            command.tagged
              ? [...current, command.tag]
              : current.filter((tag) => tag !== command.tag),
          );
          return {} as never;
        }),
    }),
    Layer.mock(PeerLinks.PeerLinks)({
      enabled: Effect.succeed(true),
      names: Effect.succeed(LINKS.map((link) => ({ environmentId: link.id, label: link.label }))),
      get: (environmentId) =>
        Effect.succeed(
          Option.fromUndefinedOr(LINKS.find((link) => link.id === environmentId)).pipe(
            Option.map((link) => ({ label: link.label, access: link.access }) as never),
          ),
        ),
    }),
    // A linked machine answers as its own tool would; the sleeping one never answers.
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: (input) =>
        Effect.gen(function* () {
          peerCalls.push(input.environmentId);
          if (offline.has(input.environmentId)) {
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            });
          }
          const args = input.arguments as {
            threadId: string;
            change: "join" | "leave" | "undo";
            missionId: string;
            name: string;
          };
          const key = keyOf(ref(input.environmentId, args.threadId));
          if (!tags.has(key)) {
            return yield* new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "That thread was not found.",
            });
          }
          if (args.change === "undo" && refuseUndo.has(input.environmentId)) {
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            });
          }
          const plan = planMissionTags(tags.get(key) ?? [], { ...args, kind: args.change });
          if ("refused" in plan) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: plan.refused,
            });
          }
          tags.set(key, [
            ...(tags.get(key) ?? []).filter((tag) => !plan.remove.includes(tag)),
            ...plan.add,
          ]);
          return { threadId: args.threadId } as never;
        }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
    NodeCrypto.layer,
  );
  return {
    tags: (thread: ScopedThreadRef) => tags.get(keyOf(thread)),
    deleteThread: (thread: ScopedThreadRef) => tags.delete(keyOf(thread)),
    peerCalls,
    offline,
    refuseUndo,
    layer,
  };
};

type Store = MissionStore.MissionStore["Service"];

const withMissions = <A, E>(
  world: ReturnType<typeof makeWorld>,
  use: Effect.Effect<A, E, Missions.Missions>,
  /** Replaces store methods, to make the store refuse or fail. */
  adjustStore: (store: Store) => Partial<Store> = () => ({}),
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missions-" });
    const store = Layer.effect(
      MissionStore.MissionStore,
      Effect.map(MissionStore.MissionStore, (real) =>
        MissionStore.MissionStore.of({ ...real, ...adjustStore(real) }),
      ),
    ).pipe(Layer.provide(MissionStore.layerFromPath(path.join(directory, "missions.sqlite"))));
    return yield* Effect.provide(
      use,
      Missions.layer.pipe(Layer.provide(Layer.merge(store, world.layer))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const lead = ref(HERE, "lead");
const localMember = ref(HERE, "local");
const laptopMember = ref(LAPTOP, "laptop");

it.effect(
  "creating a mission tags its lead, and adding tags each member on its own machine",
  () => {
    const world = makeWorld([
      [lead, []],
      [localMember, ["private"]],
      [laptopMember, []],
    ]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* missions.create({ name: "Ship v2", leadThreadId: lead.threadId });
        const tag = `mission:${mission.missionId}:Ship v2`;
        assert.deepEqual(world.tags(lead), [tag]);

        yield* missions.addMember({ missionId: mission.missionId, member: localMember });
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        assert.deepEqual(world.tags(localMember), ["private", tag]);
        assert.deepEqual(world.tags(laptopMember), [tag]);
        assert.deepEqual(world.peerCalls, [LAPTOP]);

        const snapshot = yield* missions.watch.pipe(Stream.runHead);
        const [listed] = Option.getOrThrow(snapshot).missions;
        assert.deepEqual(
          listed!.members.map((member) => [member.ref.threadId, member.role]),
          [
            ["lead", "lead"],
            ["local", "member"],
            ["laptop", "member"],
          ],
        );
        assert.deepEqual(
          Option.getOrThrow(snapshot).links.map((link) => [link.label, link.fullAccess]),
          [
            ["Laptop", true],
            ["Fenced box", false],
            ["Sleeping box", true],
          ],
        );
      }),
    );
  },
);

it.effect("a thread already in a mission is refused, here or by the tag on its machine", () => {
  const taggedElsewhere = ref(LAPTOP, "elsewhere");
  const world = makeWorld([
    [lead, []],
    [ref(HERE, "other-lead"), []],
    [localMember, []],
    [taggedElsewhere, ["mission:abc:Someone else's"]],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const first = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      const second = yield* missions.create({
        name: "Two",
        leadThreadId: ThreadId.make("other-lead"),
      });
      yield* missions.addMember({ missionId: first.missionId, member: localMember });

      const again = yield* missions
        .addMember({ missionId: second.missionId, member: localMember })
        .pipe(Effect.flip);
      assert.equal(again.message, 'This thread is already in the mission "One".');
      const leadTaken = yield* missions
        .create({ name: "Three", leadThreadId: localMember.threadId })
        .pipe(Effect.flip);
      assert.equal(leadTaken.message, 'This thread is already in the mission "One".');

      const elsewhere = yield* missions
        .addMember({ missionId: second.missionId, member: taggedElsewhere })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "already in another mission");
      assert.deepEqual(world.tags(taggedElsewhere), ["mission:abc:Someone else's"]);
      const [, listed] = Option.getOrThrow(yield* missions.watch.pipe(Stream.runHead)).missions;
      assert.equal(listed!.members.length, 1);
    }),
  );
});

it.effect("releasing a member replaces its tag, and the lead cannot be released", () => {
  const world = makeWorld([
    [lead, []],
    [laptopMember, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "Ship v2", leadThreadId: lead.threadId });
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });

      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      assert.deepEqual(world.tags(laptopMember), [`mission-was:${mission.missionId}:Ship v2`]);
      const refused = yield* missions
        .releaseMember({ missionId: mission.missionId, member: lead })
        .pipe(Effect.flip);
      assert.include(refused.message, "lead cannot be released");

      // Rejoining drops the old release mark.
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      assert.deepEqual(world.tags(laptopMember), [`mission:${mission.missionId}:Ship v2`]);
    }),
  );
});

it.effect("a thread behind a link below full access is refused before anything is sent", () => {
  const fenced = ref(FENCED, "fenced");
  const world = makeWorld([
    [lead, []],
    [fenced, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: fenced })
        .pipe(Effect.flip);
      assert.include(refused.message, "The link to Fenced box has auto access");
      assert.deepEqual(world.peerCalls, []);
      assert.deepEqual(world.tags(fenced), []);
    }),
  );
});

it.effect("a member machine that does not answer fails the add and the release visibly", () => {
  const sleeping = ref(OFFLINE, "sleeping");
  const world = makeWorld([
    [lead, []],
    [sleeping, []],
    [laptopMember, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      const failed = yield* missions
        .addMember({ missionId: mission.missionId, member: sleeping })
        .pipe(Effect.flip);
      assert.equal(
        failed.message,
        "Sleeping box did not change the thread's mission tag, so nothing changed. The linked environment stopped answering.",
      );

      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      world.offline.add(LAPTOP);
      const release = yield* missions
        .releaseMember({ missionId: mission.missionId, member: laptopMember })
        .pipe(Effect.flip);
      assert.include(release.message, "Laptop did not change the thread's mission tag");
      assert.equal(release.reason, "unreachable");
      assert.deepEqual(world.tags(laptopMember), [`mission:${mission.missionId}:One`]);
      const [listed] = Option.getOrThrow(yield* missions.watch.pipe(Stream.runHead)).missions;
      assert.deepEqual(
        listed!.members.map((member) => member.ref.threadId),
        ["lead", "laptop"],
      );

      // Removing it anyway drops the record and leaves the tag on the unreachable machine.
      yield* missions.releaseMember({
        missionId: mission.missionId,
        member: laptopMember,
        leaveTag: true,
      });
      assert.deepEqual(world.tags(laptopMember), [`mission:${mission.missionId}:One`]);
      const [after] = Option.getOrThrow(yield* missions.watch.pipe(Stream.runHead)).missions;
      assert.deepEqual(
        after!.members.map((member) => member.ref.threadId),
        ["lead"],
      );
    }),
  );
});

it.effect("releasing a member whose thread is gone on its machine drops the membership", () => {
  const world = makeWorld([
    [lead, []],
    [laptopMember, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      world.deleteThread(laptopMember);

      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      const [listed] = Option.getOrThrow(yield* missions.watch.pipe(Stream.runHead)).missions;
      assert.deepEqual(
        listed!.members.map((member) => member.ref.threadId),
        ["lead"],
      );
    }),
  );
});

it.effect("a join the store refuses is taken back off the member", () => {
  const world = makeWorld([
    [lead, []],
    [localMember, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: localMember })
        .pipe(Effect.flip);
      assert.equal(
        refused.message,
        "This thread joined another mission meanwhile, so it was not added. Its mission tag was taken off again.",
      );
      assert.deepEqual(world.tags(localMember), []);
    }),
    () => ({ addMember: () => Effect.succeed(false) }),
  );
});

it.effect("a join the store fails to save is taken back off the member and the lead", () => {
  const world = makeWorld([
    [lead, []],
    [laptopMember, []],
  ]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const unsaved = yield* missions
        .create({ name: "One", leadThreadId: lead.threadId })
        .pipe(Effect.flip);
      assert.equal(
        unsaved.message,
        "This machine could not save the mission, so the thread was not added. Its mission tag was taken off again.",
      );
      assert.deepEqual(world.tags(lead), []);
    }),
    () => ({ create: () => Effect.die(new Error("disk I/O error")) }),
  );
});

it.effect("when taking a tag back off also fails, the error says which tag is left", () => {
  const world = makeWorld([
    [lead, []],
    [laptopMember, []],
  ]);
  world.refuseUndo.add(LAPTOP);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* missions.create({ name: "One", leadThreadId: lead.threadId });
      const unsaved = yield* missions
        .addMember({ missionId: mission.missionId, member: laptopMember })
        .pipe(Effect.flip);
      assert.include(
        unsaved.message,
        `Taking its tag "mission:${mission.missionId}:One" off again also failed, so remove that tag by hand.`,
      );
      assert.deepEqual(world.tags(laptopMember), [`mission:${mission.missionId}:One`]);
    }),
    () => ({ addMember: () => Effect.die(new Error("disk I/O error")) }),
  );
});

it("cuts a long mission tag to the tag limit and keeps the mission id whole", () => {
  const plan = planMissionTags([], {
    kind: "join",
    missionId: "0123456789ab",
    name: "x".repeat(80),
  });
  assert.deepEqual(plan, { remove: [], add: [`mission:0123456789ab:${"x".repeat(43)}`] });
});
