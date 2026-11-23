import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthMcpClientAccess,
  CommandId,
  EnvironmentId,
  type Mission,
  MissionError,
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

type Claims = MissionClaims.MissionClaims["Service"];
type Store = MissionStore.MissionStore["Service"];

/** Every machine's threads and tags, and how the laptop answers this lead. */
const makeWorld = (threads: ReadonlyArray<ScopedThreadRef>) => {
  const tags = new Map(threads.map((thread) => [keyOf(thread), [] as Array<string>]));
  const laptop = {
    claims: undefined as Claims | undefined,
    /** `offline`: refuses to connect. `hanging`: never answers. `lostReply`: acts, then drops the reply. */
    mode: "up" as "up" | "offline" | "hanging" | "lostReply",
    calls: 0,
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
      readonly kind: "join" | "leave" | "undo" | "list";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly name: string;
      readonly claimId: string;
    };
    switch (args.kind) {
      case "join":
        return Effect.map(claims.join(LEAD_ON_LAPTOP, args), (claim) => [claim]);
      case "leave":
        return Effect.as(claims.leave(LEAD_ON_LAPTOP, args), []);
      case "undo":
        return Effect.as(claims.undo(LEAD_ON_LAPTOP, args), []);
      case "list":
        return claims.list(LEAD_ON_LAPTOP);
    }
  };
  const peers = Layer.mock(PeerMcpClient.PeerMcpClient)({
    call: ((input: { readonly arguments: Record<string, unknown> }) =>
      Effect.gen(function* () {
        laptop.calls += 1;
        const stoppedAnswering = new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The linked environment stopped answering.",
        });
        if (laptop.mode === "offline") return yield* stoppedAnswering;
        if (laptop.mode === "hanging") return yield* Effect.never;
        const claims = yield* answer(laptop.claims!, input.arguments).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
        if (laptop.mode === "lostReply") return yield* stoppedAnswering;
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
  use: Effect.Effect<A, E, Missions.Missions>,
  /** Replaces the lead's store methods, to make them refuse or fail. */
  adjustStore: (store: Store) => Partial<Store> = () => ({}),
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missions-" });
    const claimsOn = <E>(
      environmentId: EnvironmentId,
      store: Layer.Layer<MissionStore.MissionStore, E>,
    ) =>
      MissionClaims.layer.pipe(
        Layer.provideMerge(store),
        Layer.provide(Layer.merge(world.threadsOn(environmentId), NodeCrypto.layer)),
      );
    world.laptop.claims = Context.get(
      yield* Layer.build(
        claimsOn(LAPTOP, MissionStore.layerFromPath(path.join(directory, "laptop.sqlite"))),
      ),
      MissionClaims.MissionClaims,
    );
    const leadStore = Layer.effect(
      MissionStore.MissionStore,
      Effect.map(MissionStore.MissionStore, (real) =>
        MissionStore.MissionStore.of({ ...real, ...adjustStore(real) }),
      ),
    ).pipe(Layer.provide(MissionStore.layerFromPath(path.join(directory, "here.sqlite"))));
    return yield* Effect.provide(
      use,
      Missions.layer.pipe(Layer.provide(Layer.merge(claimsOn(HERE, leadStore), world.layer))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const listed = Effect.flatMap(Missions.Missions, (missions) =>
  missions.watch.pipe(
    Stream.runHead,
    Effect.map((snapshot) => Option.getOrThrow(snapshot)),
  ),
);
const membersOf = (mission: Mission | undefined) =>
  mission?.members.map((member) => [member.ref.threadId, member.state]);
const createOne = Effect.flatMap(Missions.Missions, (missions) =>
  missions.create({ missionId: "0123456789ab", name: "One", leadThreadId: lead.threadId }),
);

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
        const tag = "mission:0123456789ab:One";
        assert.deepEqual(
          [world.tags(lead), world.tags(localMember), world.tags(laptopMember)],
          [[tag], [tag], [tag]],
        );
        const snapshot = yield* listed;
        assert.deepEqual(membersOf(snapshot.missions[0]), [
          ["lead", "active"],
          ["local", "active"],
          ["laptop", "active"],
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

it.effect("a thread another lead holds is refused by its machine, and nothing is recorded", () => {
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
      assert.include(refused.message, 'already in another mission ("Theirs")');
      assert.deepEqual(membersOf((yield* listed).missions[0]), [["lead", "active"]]);
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
      assert.equal(world.laptop.calls, 0);
    }),
  );
});

it.effect("starting again with the same id returns the mission a lost reply hid", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const first = yield* createOne;
      const again = yield* createOne;
      assert.deepEqual(again, first);
      const other = yield* missions
        .create({ missionId: "0123456789ab", name: "One", leadThreadId: localMember.threadId })
        .pipe(Effect.flip);
      assert.instanceOf(other, MissionError);
      assert.equal((yield* listed).missions.length, 1);
    }),
  );
});

it.effect(
  "adding again after a lost reply succeeds, and reconcile records the claim it made",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        world.laptop.mode = "lostReply";
        const unknown = yield* missions
          .addMember({ missionId: mission.missionId, member: laptopMember })
          .pipe(Effect.flip);
        assert.include(unknown.message, "checks again when Laptop answers");
        world.laptop.mode = "up";
        yield* missions.reconcile([LAPTOP]);
        assert.deepEqual(membersOf((yield* listed).missions[0]), [
          ["lead", "active"],
          ["laptop", "active"],
        ]);
        // A retry of the same add finds the claim it already made.
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
      }),
    );
  },
);

it.effect("releasing replaces the member's tag; a lead cannot be released", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      assert.deepEqual(world.tags(laptopMember), ["mission-was:0123456789ab:One"]);
      assert.deepEqual(membersOf((yield* listed).missions[0]), [["lead", "active"]]);
      const refused = yield* missions
        .releaseMember({ missionId: mission.missionId, member: lead })
        .pipe(Effect.flip);
      assert.include(refused.message, "lead cannot be released");
    }),
  );
});

it.effect("a release whose record is not dropped here is shown released once reconciled", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      // The laptop freed the thread; the reconcile the failed write started catches the lead up.
      assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
      const settled = yield* missions.watch.pipe(
        Stream.filter((snapshot) =>
          snapshot.missions[0]!.members.every(
            (member) => member.state !== "active" || member.role === "lead",
          ),
        ),
        Stream.runHead,
      );
      assert.deepEqual(membersOf(Option.getOrThrow(settled).missions[0]), [
        ["lead", "active"],
        ["laptop", "released"],
      ]);
    }),
    () => ({ removeMember: () => Effect.die(new Error("disk I/O error")) }),
  );
});

it.effect(
  "reconcile records a claim it has no row for, and marks released a row with no claim",
  () => {
    const world = makeWorld([lead, laptopMember, ref(LAPTOP, "second")]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        yield* world.laptop.claims!.leave(LEAD_ON_LAPTOP, {
          threadId: laptopMember.threadId,
          missionId: mission.missionId,
        });
        yield* world.laptop.claims!.join(LEAD_ON_LAPTOP, {
          threadId: ThreadId.make("second"),
          missionId: mission.missionId,
          name: mission.name,
        });
        yield* missions.reconcile([LAPTOP]);
        assert.deepEqual(membersOf((yield* listed).missions[0]), [
          ["lead", "active"],
          ["laptop", "released"],
          ["second", "active"],
        ]);
      }),
    );
  },
);

it.effect(
  "a release the member's machine does not answer is pending, then finished by reconcile",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        world.laptop.mode = "hanging";
        const releasing = yield* Effect.forkChild(
          missions.releaseMember({ missionId: mission.missionId, member: laptopMember }),
        );
        yield* TestClock.adjust(Missions.MEMBER_CALL_DEADLINE);
        yield* Fiber.join(releasing);
        // Still unreachable, so the reconcile a refresh starts leaves it pending.
        world.laptop.mode = "offline";
        assert.deepEqual(membersOf((yield* listed).missions[0]), [
          ["lead", "active"],
          ["laptop", "release-pending"],
        ]);
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);

        world.laptop.mode = "up";
        yield* missions.reconcile([LAPTOP]);
        assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
        assert.deepEqual(membersOf((yield* listed).missions[0]), [["lead", "active"]]);
      }),
    );
  },
);

it.effect(
  "a thread its own machine's user leaves shows as released once the lead reconciles",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        // On the laptop, its own user leaves; the lead's link plays no part.
        yield* world.laptop.claims!.leaveHere(laptopMember.threadId);
        assert.deepEqual(world.tags(laptopMember), ["mission-was:0123456789ab:One"]);
        yield* missions.reconcile([LAPTOP]);
        assert.deepEqual(membersOf((yield* listed).missions[0]), [
          ["lead", "active"],
          ["laptop", "released"],
        ]);
      }),
    );
  },
);

it.effect("the lead thread of a mission here cannot leave it", () => {
  const world = makeWorld([lead]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      yield* createOne;
      const refused = yield* missions.leaveHere(lead.threadId).pipe(Effect.flip);
      assert.include(refused.message, "lead cannot be released");
      assert.deepEqual(world.tags(lead), ["mission:0123456789ab:One"]);
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
    // Agents and links reach this machine only through /mcp; a socket session that only reads is refused.
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

it.effect("a join the lead cannot record is taken back off the member", () => {
  const world = makeWorld([lead, localMember, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: laptopMember })
        .pipe(Effect.flip);
      assert.equal(
        refused.message,
        "This thread joined another mission meanwhile, so it was not added.",
      );
      assert.deepEqual(world.tags(laptopMember), []);
      assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
    }),
    () => ({ addMember: () => Effect.succeed(false) }),
  );
});

it.effect("a mission the lead cannot save leaves no claim on its lead", () => {
  const world = makeWorld([lead]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const unsaved = yield* createOne.pipe(Effect.flip);
      assert.equal(
        unsaved.message,
        "This machine could not save the mission, so the thread was not added.",
      );
      assert.deepEqual(world.tags(lead), []);
    }),
    () => ({ create: () => Effect.die(new Error("disk I/O error")) }),
  );
});

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
