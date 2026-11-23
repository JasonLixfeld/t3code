import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthMcpClientAccess,
  CommandId,
  EnvironmentId,
  type Mission,
  type MissionError,
  type MissionsSnapshot,
  OrchestratorMcpFailure,
  type ScopedThreadRef,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as MissionClaims from "./MissionClaims.ts";
import * as MissionStore from "./MissionStore.ts";
import * as Missions from "./Missions.ts";

const HERE = EnvironmentId.make("env-here");
const LAPTOP = EnvironmentId.make("env-laptop");
const FENCED = EnvironmentId.make("env-fenced");
const LINKS: ReadonlyArray<{ id: EnvironmentId; label: string; access: AuthMcpClientAccess }> = [
  { id: LAPTOP, label: "Laptop", access: "full-access" },
  { id: FENCED, label: "Fenced box", access: "auto" },
];
/** How the laptop knows this lead: by the link session it calls with. */
const LEAD_ON_LAPTOP = MissionClaims.linkOwner("lead-session");

const ref = (environmentId: EnvironmentId, threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});
const keyOf = (thread: ScopedThreadRef) => `${thread.environmentId}/${thread.threadId}`;
const lead = ref(HERE, "lead");
const localMember = ref(HERE, "local");
const laptopMember = ref(LAPTOP, "laptop");
const TAG = "mission:0123456789ab:One";
const WAS_TAG = "mission-was:0123456789ab:One";

type Claims = MissionClaims.MissionClaims["Service"];
type ClaimKind = "join" | "release" | "list";

/** Every machine's threads and tags, and how the laptop answers this lead. */
const makeWorld = (threads: ReadonlyArray<ScopedThreadRef>) => {
  const tags = new Map(threads.map((thread) => [keyOf(thread), [] as Array<string>]));
  const laptop = {
    claims: undefined as Claims | undefined,
    /** `offline`: refuses to connect. `hanging`: never answers. `lostReply`: acts, then drops the reply. */
    mode: "up" as "up" | "offline" | "hanging" | "lostReply",
    /** Every call this lead made to the laptop, in order. */
    calls: [] as Array<ClaimKind>,
    /** The same calls, to wait on: each is offered as it starts, under the mode set by then. */
    started: undefined as Queue.Queue<ClaimKind> | undefined,
  };
  const threadsOn = (environmentId: EnvironmentId) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const current = tags.get(keyOf(ref(environmentId, threadId)));
          return (
            current === undefined ? null : { id: threadId, deletedAt: null, tags: [...current] }
          ) as never;
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "thread.tag.set") throw new Error(`unexpected ${command.type}`);
          const current = tags.get(keyOf(ref(environmentId, command.threadId)))!;
          if (command.tagged) current.push(command.tag);
          else current.splice(current.indexOf(command.tag), 1);
          return {} as never;
        }),
    });
  const answer = (
    claims: Claims,
    call: Record<string, unknown>,
  ): Effect.Effect<ReadonlyArray<unknown>, MissionError> => {
    const args = call as {
      readonly kind: ClaimKind;
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly name: string;
      readonly generation: string;
    };
    switch (args.kind) {
      case "join":
        return Effect.map(claims.join(LEAD_ON_LAPTOP, args), (claim) => [claim]);
      case "release":
        return Effect.as(claims.release(LEAD_ON_LAPTOP, args), []);
      case "list":
        return claims.list(LEAD_ON_LAPTOP);
    }
  };
  const peers = Layer.mock(PeerMcpClient.PeerMcpClient)({
    call: ((input: { readonly arguments: { readonly kind: ClaimKind } }) =>
      Effect.gen(function* () {
        const mode = laptop.mode;
        laptop.calls.push(input.arguments.kind);
        yield* Queue.offer(laptop.started!, input.arguments.kind);
        const stoppedAnswering = new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The linked environment stopped answering.",
        });
        if (mode === "offline") return yield* stoppedAnswering;
        if (mode === "hanging") return yield* Effect.never;
        const claims = yield* answer(laptop.claims!, input.arguments).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
        if (mode === "lostReply") return yield* stoppedAnswering;
        return { claims };
      })) as never,
  });
  const links = Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(true),
    names: Effect.succeed(LINKS.map((link) => ({ environmentId: link.id, label: link.label }))),
    get: (environmentId) =>
      Effect.succeed(
        Option.fromUndefinedOr(LINKS.find((link) => link.id === environmentId)).pipe(
          Option.map((link) => ({ label: link.label, access: link.access }) as never),
        ),
      ),
  });
  return {
    tags: (thread: ScopedThreadRef) => tags.get(keyOf(thread)),
    laptop,
    /** The next calls this lead starts on the laptop, waiting for each. */
    nextCalls: (count: number) => Queue.takeN(laptop.started!, count),
    threadsOn,
    layer: Layer.mergeAll(
      peers,
      links,
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
      NodeCrypto.layer,
    ),
  };
};

const withMissions = <A, E>(
  world: ReturnType<typeof makeWorld>,
  use: Effect.Effect<A, E, Missions.Missions | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missions-" });
    const claimsOn = (environmentId: EnvironmentId) =>
      MissionClaims.layer.pipe(
        Layer.provideMerge(
          MissionStore.layerFromPath(path.join(directory, `${environmentId}.sqlite`)),
        ),
        Layer.provide(Layer.merge(world.threadsOn(environmentId), NodeCrypto.layer)),
      );
    world.laptop.started = yield* Queue.unbounded<ClaimKind>();
    world.laptop.claims = Context.get(
      yield* Layer.build(claimsOn(LAPTOP)),
      MissionClaims.MissionClaims,
    );
    return yield* Effect.provide(
      use,
      Missions.layer.pipe(Layer.provide(Layer.merge(claimsOn(HERE), world.layer))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const listed = Effect.flatMap(Missions.Missions, (missions) =>
  missions.watch.pipe(
    Stream.runHead,
    Effect.map((snapshot) => Option.getOrThrow(snapshot)),
  ),
);
const membersOf = (mission: Mission | undefined) =>
  mission?.members.map((member) => [keyOf(member.ref), member.state]);
const stateOf = (snapshot: MissionsSnapshot, thread: ScopedThreadRef) =>
  snapshot.missions[0]?.members.find((member) => keyOf(member.ref) === keyOf(thread))?.state;
const createOne = Effect.flatMap(Missions.Missions, (missions) =>
  missions.create({ missionId: "0123456789ab", name: "One", leadThreadId: lead.threadId }),
);

/**
 * A client that keeps watching, as an open sidebar does. Answers a wait for the next snapshot
 * that matches. While it watches, only the interval and unknown outcomes ask the laptop again.
 */
const openSidebar = Effect.gen(function* () {
  const missions = yield* Missions.Missions;
  const seen = yield* Queue.unbounded<MissionsSnapshot>();
  yield* missions.watch.pipe(
    Stream.runForEach((snapshot) => Queue.offer(seen, snapshot)),
    Effect.forkScoped,
  );
  const until = (matches: (snapshot: MissionsSnapshot) => boolean): Effect.Effect<void> =>
    Effect.flatMap(Queue.take(seen), (snapshot) =>
      matches(snapshot) ? Effect.void : until(matches),
    );
  yield* Queue.take(seen);
  return until;
});

it.effect(
  "starting a mission claims its lead, and adding claims each member on its machine",
  () => {
    const world = makeWorld([lead, localMember, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: localMember });
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        assert.deepEqual(
          [world.tags(lead), world.tags(localMember), world.tags(laptopMember)],
          [[TAG], [TAG], [TAG]],
        );
        const snapshot = yield* listed;
        assert.deepEqual(membersOf(snapshot.missions[0]), [
          ["env-here/lead", "active"],
          ["env-here/local", "active"],
          ["env-laptop/laptop", "active"],
        ]);
        assert.deepEqual(
          snapshot.links.map((link) => [link.label, link.fullAccess]),
          [
            ["Laptop", true],
            ["Fenced box", false],
          ],
        );
      }),
    );
  },
);

it.effect("a thread another lead holds is refused by its machine, and is not listed", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      yield* world.laptop.claims!.join("link:another-lead", {
        threadId: laptopMember.threadId,
        missionId: "ffffffffffff",
        name: "Theirs",
      });
      const mission = yield* createOne;
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: laptopMember })
        .pipe(Effect.flip);
      assert.include(refused.message, 'already in the mission "Theirs"');
      assert.deepEqual(membersOf((yield* listed).missions[0]), [["env-here/lead", "active"]]);
    }),
  );
});

it.effect("a thread behind a link below full access is refused before anything is sent", () => {
  const fenced = ref(FENCED, "fenced");
  const world = makeWorld([lead, fenced]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: fenced })
        .pipe(Effect.flip);
      assert.include(refused.message, "The link to Fenced box has auto access");
      assert.deepEqual(world.laptop.calls, []);
    }),
  );
});

it.effect(
  "starting again with the same id returns the mission; any other reuse leaves its members alone",
  () => {
    const world = makeWorld([lead, localMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const first = yield* createOne;
        assert.deepEqual(yield* createOne, first);
        yield* missions.addMember({ missionId: first.missionId, member: localMember });

        const sameId = yield* missions
          .create({ missionId: first.missionId, name: "One", leadThreadId: localMember.threadId })
          .pipe(Effect.flip);
        assert.equal(sameId.message, "Another mission already uses this id.");
        const held = yield* missions
          .create({ missionId: "ba9876543210", name: "Two", leadThreadId: localMember.threadId })
          .pipe(Effect.flip);
        assert.include(held.message, 'already in the mission "One"');

        assert.deepEqual(world.tags(localMember), [TAG]);
        const snapshot = yield* listed;
        assert.equal(snapshot.missions.length, 1);
        assert.deepEqual(membersOf(snapshot.missions[0]), [
          ["env-here/lead", "active"],
          ["env-here/local", "active"],
        ]);
      }),
    );
  },
);

it.effect("a join whose reply was lost is listed once the laptop answers again", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      world.laptop.mode = "lostReply";
      const unknown = yield* missions
        .addMember({ missionId: mission.missionId, member: laptopMember })
        .pipe(Effect.flip);
      assert.include(unknown.message, "checks again when Laptop answers");
      // The check that follows at once gets no reply either, and nothing remembers to try again.
      assert.deepEqual(yield* world.nextCalls(2), ["join", "list"]);

      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => stateOf(snapshot, laptopMember) === "active");
      // A retry of the same add finds the claim it already made.
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
    }),
  );
});

it.effect("releasing replaces the member's tag; a lead cannot be released", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
      assert.deepEqual(membersOf((yield* listed).missions[0]), [["env-here/lead", "active"]]);
      const refused = yield* missions
        .releaseMember({ missionId: mission.missionId, member: lead })
        .pipe(Effect.flip);
      assert.include(refused.message, "lead cannot be released");
    }),
  );
});

it.effect("threads with one id on two machines, and in two missions, are told apart", () => {
  const sameHere = ref(HERE, "same");
  const sameLaptop = ref(LAPTOP, "same");
  const otherLead = ref(HERE, "other-lead");
  const world = makeWorld([lead, otherLead, sameHere, sameLaptop]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      yield* missions.create({
        missionId: "ba9876543210",
        name: "Two",
        leadThreadId: otherLead.threadId,
      });
      yield* missions.addMember({ missionId: mission.missionId, member: sameLaptop });
      yield* missions.addMember({ missionId: mission.missionId, member: sameHere });
      const both = yield* listed;
      assert.deepEqual(membersOf(both.missions[0]), [
        ["env-here/lead", "active"],
        ["env-here/same", "active"],
        ["env-laptop/same", "active"],
      ]);
      assert.deepEqual(membersOf(both.missions[1]), [["env-here/other-lead", "active"]]);

      world.laptop.mode = "offline";
      yield* missions.releaseMember({ missionId: mission.missionId, member: sameLaptop });
      // The release, then the check that follows it at once.
      assert.deepEqual(yield* world.nextCalls(3), ["join", "release", "release"]);
      assert.deepEqual(
        [stateOf(yield* listed, sameLaptop), stateOf(yield* listed, sameHere)],
        ["release-pending", "active"],
      );
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => stateOf(snapshot, sameLaptop) === undefined);

      assert.deepEqual(world.tags(sameLaptop), [WAS_TAG]);
      assert.deepEqual(world.tags(sameHere), [TAG]);
      assert.equal(stateOf(yield* listed, sameHere), "active");
    }),
  );
});

it.effect(
  "an offline machine's members show as last known; a thread its own user frees is dropped",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const until = yield* openSidebar;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });

        world.laptop.mode = "offline";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === "offline");
        world.laptop.mode = "up";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === "active");

        // On the laptop, its own user leaves; the lead's link plays no part.
        yield* world.laptop.claims!.leaveHere(laptopMember.threadId);
        assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === undefined);
      }),
    );
  },
);

it.effect(
  "a release the member's machine does not answer is pending, and is sent again until it answers",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const until = yield* openSidebar;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        world.laptop.mode = "hanging";
        const releasing = yield* Effect.forkChild(
          missions.releaseMember({ missionId: mission.missionId, member: laptopMember }),
        );
        yield* TestClock.adjust(Missions.MEMBER_CALL_DEADLINE);
        yield* Fiber.join(releasing);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === "release-pending");
        // The release, then the check that follows it at once, which hangs as well.
        assert.deepEqual(yield* world.nextCalls(3), ["join", "release", "release"]);
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);

        world.laptop.mode = "offline";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        assert.deepEqual(yield* world.nextCalls(1), ["release"]);
        assert.equal(stateOf(yield* listed, laptopMember), "release-pending");

        world.laptop.mode = "up";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === undefined);
        assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
        assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
      }),
    );
  },
);

it.effect(
  "a thread added again stays a member, whatever becomes of the release sent before",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        yield* openSidebar;
        const mission = yield* createOne;
        const member = { missionId: mission.missionId, member: laptopMember };
        yield* missions.addMember(member);
        const [first] = yield* world.laptop.claims!.list(LEAD_ON_LAPTOP);
        world.laptop.mode = "offline";
        yield* missions.releaseMember(member);
        // The release, then the check that follows it at once.
        assert.deepEqual(yield* world.nextCalls(3), ["join", "release", "release"]);
        assert.equal(stateOf(yield* listed, laptopMember), "release-pending");

        // Added again before the laptop heard of the release: the release is taken back.
        world.laptop.mode = "up";
        yield* missions.addMember(member);
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        assert.deepEqual(yield* world.nextCalls(2), ["join", "list"]);
        assert.equal(stateOf(yield* listed, laptopMember), "active");

        // The laptop's user frees the thread and the lead adds it once more. Only then does the
        // release sent at the start arrive.
        yield* world.laptop.claims!.leaveHere(laptopMember.threadId);
        yield* missions.addMember(member);
        yield* world.laptop.claims!.release(LEAD_ON_LAPTOP, {
          threadId: laptopMember.threadId,
          missionId: mission.missionId,
          generation: first!.generation,
        });
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
        assert.deepEqual(world.tags(laptopMember), [TAG]);
        assert.equal(stateOf(yield* listed, laptopMember), "active");
      }),
    );
  },
);

it.effect("many watching clients share one sweep, at the start and on each interval", () => {
  const world = makeWorld([lead]);
  return withMissions(
    world,
    Effect.gen(function* () {
      yield* createOne;
      yield* Effect.forEach([1, 2, 3, 4, 5], () => openSidebar, { concurrency: "unbounded" });
      assert.deepEqual(yield* world.nextCalls(1), ["list"]);
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      assert.deepEqual(yield* world.nextCalls(1), ["list"]);
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      assert.deepEqual(yield* world.nextCalls(1), ["list"]);
      assert.deepEqual(world.laptop.calls, ["list", "list", "list"]);
    }),
  );
});

it.effect("the lead thread of a mission here cannot leave it", () => {
  const world = makeWorld([lead]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      yield* createOne;
      const refused = yield* missions.leaveHere(lead.threadId).pipe(Effect.flip);
      assert.include(refused.message, "lead cannot be released");
      assert.deepEqual(world.tags(lead), [TAG]);
    }),
  );
});

it.effect("only a session that may operate threads can leave a mission over the socket", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.missionsLeave
        > => tag !== WS_METHODS.missionsLeave,
      ),
    );
    const left: Array<string> = [];
    const handler = group.toLayerHandler(WS_METHODS.missionsLeave, ({ threadId }) =>
      Effect.sync(() => void left.push(threadId)),
    );
    const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handler, RpcAuthorization.layer(scopes))),
      );
    const input = { threadId: ThreadId.make("thread") };
    // A socket session that only reads is refused.
    const reader = yield* clientWith([AuthOrchestrationReadScope]);
    assert.equal(
      (yield* reader[WS_METHODS.missionsLeave](input).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );
    assert.deepEqual(left, []);
    const operator = yield* clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    yield* operator[WS_METHODS.missionsLeave](input);
    assert.deepEqual(left, ["thread"]);
  }).pipe(Effect.scoped),
);

it.effect("a client cannot set or clear mission tags through the generic tag command", () =>
  Effect.gen(function* () {
    const setTag = (tag: string) =>
      Missions.refuseClientMissionTag({
        type: "thread.tag.set",
        commandId: CommandId.make("command"),
        threadId: ThreadId.make("thread"),
        tag,
        tagged: false,
      }).pipe(Effect.result);
    assert.equal((yield* setTag("mission:0123456789ab:One"))._tag, "Failure");
    assert.equal((yield* setTag("mission-was:0123456789ab:One"))._tag, "Failure");
    assert.equal((yield* setTag("private"))._tag, "Success");
  }),
);
