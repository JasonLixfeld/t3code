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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MissionClaims from "./MissionClaims.ts";
import { memberStatusOf } from "./missionStatus.ts";
import * as MissionTurnContexts from "./MissionTurnContexts.ts";
import { releaseDeletedThreads } from "./MissionThreadDeletions.ts";
import { afterAnswer, afterMiss, newTombstoneCheck } from "./tombstoneChecks.ts";
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
type ClaimKind = "join" | "release" | "list" | "rename";

/** Every machine's threads and tags, and how the laptop answers this lead. */
const makeWorld = (threads: ReadonlyArray<ScopedThreadRef>) => {
  const tags = new Map(threads.map((thread) => [keyOf(thread), [] as Array<string>]));
  /** Every thread is titled "One" and has messages, unless a test says otherwise. */
  const titles = new Map<string, string>();
  const empty = new Set<string>();
  const archived = new Set<string>();
  /** Each thread's run state, idle unless a test says otherwise. */
  const activity = new Map<string, Record<string, unknown>>();
  /** What Settings tells every mission's lead. */
  const settings = { missionDefaultPrompt: "" };
  const laptop = {
    claims: undefined as Claims | undefined,
    /**
     * `offline`: refuses to connect. `hanging`: never answers. `lostReply`: acts, then drops the
     * reply. `actsThenHangs`: acts, then never replies. `revoked`: answers HTTP 401 to the link.
     * `denies`: its tool refuses the call. `heldThenOffline`: answers this call once `letGo` is
     * done, and is offline for every call after it.
     */
    mode: "up" as
      | "up"
      | "offline"
      | "hanging"
      | "lostReply"
      | "actsThenHangs"
      | "revoked"
      | "denies"
      | "heldThenOffline",
    /** Answers `rename` as a build from before renames does: a refusal of the kind. */
    predatesRename: false,
    letGo: undefined as Deferred.Deferred<void> | undefined,
    /** The link session this lead calls with, and when the link was made. Both change on a re-pair. */
    session: "lead-session",
    linkedAt: "2026-01-01T00:00:00.000Z",
    /** Every call this lead made to the laptop, in order. */
    calls: [] as Array<ClaimKind>,
    /** The same calls, to wait on: each is offered as it starts, under the mode set by then. */
    started: undefined as Queue.Queue<ClaimKind> | undefined,
    /** The calls the laptop answered, each offered once its answer is ready. */
    answered: undefined as Queue.Queue<ClaimKind> | undefined,
    /** The calls the laptop carried out, whether or not its reply got through. */
    acted: undefined as Queue.Queue<ClaimKind> | undefined,
    /** The lead's link to the laptop has run out. */
    linkExpired: false,
  };
  const threadsOn = (environmentId: EnvironmentId) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.suspend(() => world.beforeShellRead(threadId)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const current = tags.get(keyOf(ref(environmentId, threadId)));
              const key = keyOf(ref(environmentId, threadId));
              return (
                current === undefined
                  ? null
                  : {
                      id: threadId,
                      deletedAt: null,
                      archivedAt: archived.has(key) ? "2026-01-02T00:00:00.000Z" : null,
                      tags: [...current],
                      title: titles.get(key) ?? "One",
                      latestUserMessageAt: empty.has(key) ? null : "2026-01-01T00:00:00.000Z",
                      visibleItemCount: empty.has(key) ? 0 : 1,
                      projectId: "project-web",
                      status: "idle",
                      activeRunId: null,
                      pendingRuntimeRequest: null,
                      hasActionableProposedPlan: false,
                      settledAt: null,
                      settledOverride: null,
                      ...activity.get(key),
                    }
              ) as never;
            }),
          ),
        ),
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
      readonly intentId: string;
    };
    const owner = MissionClaims.linkOwner(laptop.session);
    switch (args.kind) {
      case "join":
        return Effect.map(claims.join(owner, args), (claim) =>
          claim === "intent-spent" ? [] : [claim],
        );
      case "release":
        return Effect.as(claims.release(owner, args), []);
      case "list":
        // As the laptop's /mcp answers: each claim with what its thread is doing.
        return Effect.map(claims.list(owner), (held) =>
          held.map((claim) => ({
            ...claim,
            detail: {
              status: memberStatusOf({
                status: "idle",
                pendingRuntimeRequest: null,
                hasActionableProposedPlan: false,
                ...activity.get(keyOf(ref(LAPTOP, claim.threadId))),
              } as never),
              title: "One",
              project: "api",
            },
          })),
        );
      case "rename":
        return claims.rename(owner, args);
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
        if (input.arguments.kind === "rename" && laptop.predatesRename) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Invalid parameters for tool 't3_mission_tag'",
          });
        }
        if (mode === "hanging") return yield* Effect.never;
        if (mode === "heldThenOffline") {
          laptop.mode = "offline";
          yield* Deferred.await(laptop.letGo!);
        }
        if (mode === "revoked" || mode === "denies") {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              mode === "revoked"
                ? PeerMcpClient.LINK_NOT_ACCEPTED
                : "This link may change only threads it started.",
          });
        }
        const claims = yield* answer(laptop.claims!, input.arguments).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
        yield* Queue.offer(laptop.acted!, input.arguments.kind);
        if (mode === "lostReply") return yield* stoppedAnswering;
        if (mode === "actsThenHangs") return yield* Effect.never;
        yield* Queue.offer(laptop.answered!, input.arguments.kind);
        return { claims };
      })) as never,
  });
  const links = Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(true),
    names: Effect.succeed(LINKS.map((link) => ({ environmentId: link.id, label: link.label }))),
    get: (environmentId) =>
      Effect.succeed(
        Option.fromUndefinedOr(LINKS.find((link) => link.id === environmentId)).pipe(
          Option.map(
            (link) =>
              ({
                label: link.label,
                access: link.access,
                linkedAt: DateTime.makeUnsafe(laptop.linkedAt),
                expiresAt: DateTime.makeUnsafe(
                  link.id === LAPTOP && laptop.linkExpired ? 0 : "2999-01-01T00:00:00.000Z",
                ),
              }) as never,
          ),
        ),
      ),
  });
  const world = {
    tags: (thread: ScopedThreadRef) => tags.get(keyOf(thread)),
    /** The thread's own user deletes it. */
    remove: (thread: ScopedThreadRef) => tags.delete(keyOf(thread)),
    retitle: (thread: ScopedThreadRef, title: string) => titles.set(keyOf(thread), title),
    /** The thread's own user archives it. */
    archive: (thread: ScopedThreadRef) => archived.add(keyOf(thread)),
    /** The thread has no messages yet, as a new draft thread. */
    empty: (thread: ScopedThreadRef) => empty.add(keyOf(thread)),
    /** Sets fields of the thread's shell, such as its run status. */
    shell: (thread: ScopedThreadRef, fields: Record<string, unknown>) =>
      activity.set(keyOf(thread), { ...activity.get(keyOf(thread)), ...fields }),
    settings,
    laptop,
    /** The next calls this lead starts on the laptop, waiting for each. */
    nextCalls: (count: number) => Queue.takeN(laptop.started!, count),
    /** Waits until the laptop has answered a call of this kind. */
    untilAnswered: (kind: ClaimKind): Effect.Effect<void> =>
      Effect.flatMap(Queue.take(laptop.answered!), (answered) =>
        answered === kind ? Effect.void : world.untilAnswered(kind),
      ),
    /** Waits until this lead has started a call of this kind on the laptop. */
    untilStarted: (kind: ClaimKind): Effect.Effect<void> =>
      Effect.flatMap(Queue.take(laptop.started!), (started) =>
        started === kind ? Effect.void : world.untilStarted(kind),
      ),
    /** Waits until the laptop has carried out a call of this kind, reply or no reply. */
    untilActed: (kind: ClaimKind): Effect.Effect<void> =>
      Effect.flatMap(Queue.take(laptop.acted!), (acted) =>
        acted === kind ? Effect.void : world.untilActed(kind),
      ),
    /** Runs after each read of the lead's known claims, in the fiber that read them. */
    afterKnownClaimsRead: Effect.void as Effect.Effect<void>,
    /** Runs once, after the lead has stopped and before it starts again. */
    whileStopped: Effect.void as Effect.Effect<void>,
    /** Writes the lead's database before it first starts, as an earlier build left it. */
    leadDatabase: Effect.void as Effect.Effect<
      void,
      Migrator.MigrationError | SqlError.SqlError,
      SqlClient.SqlClient
    >,
    /** Runs before each read of a thread, on any machine. */
    beforeShellRead: (_threadId: ThreadId): Effect.Effect<void> => Effect.void,
    /** Runs before the lead's next read of its missions; a test holds a snapshot open with it. */
    beforeMissionsRead: Effect.void as Effect.Effect<void>,
    /** Runs before the lead reads the releases it waits on, as an add does under its lock. */
    beforeReleasesRead: Effect.void as Effect.Effect<void>,
    /** Runs after the lead renames a mission, before its claims follow. */
    afterMissionRenamed: Effect.void as Effect.Effect<void>,
    threadsOn,
    layer: Layer.mergeAll(
      peers,
      links,
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({ ...settings }) as never),
      }),
      Layer.mock(Project.ProjectService)({
        getShell: () => Effect.succeedSome({ title: "web" } as never),
      }),
      NodeCrypto.layer,
    ),
  };
  return world;
};

/** Runs each session on a freshly started lead, over the same files and the same laptop. */
const withMissions = <A, E>(
  world: ReturnType<typeof makeWorld>,
  ...sessions: ReadonlyArray<
    Effect.Effect<
      A,
      E,
      | Missions.Missions
      | MissionStore.MissionStore
      | MissionClaims.MissionClaims
      | MissionTurnContexts.MissionTurnContexts
      | Scope.Scope
    >
  >
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missions-" });
    yield* Effect.provide(
      world.leadDatabase,
      NodeSqliteClient.layer({ filename: path.join(directory, `${HERE}.sqlite`) }),
    ).pipe(Effect.orDie);
    const claimsOn = (environmentId: EnvironmentId) =>
      MissionClaims.layer.pipe(
        Layer.provideMerge(
          Layer.effect(
            MissionStore.MissionStore,
            Effect.map(MissionStore.MissionStore, (real) =>
              MissionStore.MissionStore.of({
                ...real,
                missions: Effect.suspend(() => world.beforeMissionsRead).pipe(
                  Effect.andThen(real.missions),
                ),
                knownClaims: real.knownClaims.pipe(Effect.tap(() => world.afterKnownClaimsRead)),
                pendingReleases: Effect.suspend(() => world.beforeReleasesRead).pipe(
                  Effect.andThen(real.pendingReleases),
                ),
                renameMission: (input) =>
                  real
                    .renameMission(input)
                    .pipe(Effect.tap(Effect.suspend(() => world.afterMissionRenamed))),
              }),
            ),
          ).pipe(
            Layer.provide(
              MissionStore.layerFromPath(path.join(directory, `${environmentId}.sqlite`)),
            ),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            world.threadsOn(environmentId),
            NodeCrypto.layer,
            ThreadCommandExecutor.layer,
          ),
        ),
      );
    world.laptop.started = yield* Queue.unbounded<ClaimKind>();
    world.laptop.answered = yield* Queue.unbounded<ClaimKind>();
    world.laptop.acted = yield* Queue.unbounded<ClaimKind>();
    world.laptop.letGo = yield* Deferred.make<void>();
    world.laptop.claims = Context.get(
      yield* Layer.build(claimsOn(LAPTOP)),
      MissionClaims.MissionClaims,
    );
    const lead = Missions.layer.pipe(
      Layer.provideMerge(claimsOn(HERE)),
      Layer.provideMerge(MissionTurnContexts.layer),
      Layer.provide(Layer.mergeAll(world.threadsOn(HERE), world.layer)),
    );
    return yield* Effect.forEach(sessions, (session) =>
      Effect.scoped(Effect.provide(session, lead)).pipe(
        Effect.tap(() => {
          const stopped = world.whileStopped;
          world.whileStopped = Effect.void;
          return stopped;
        }),
      ),
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
  missions.create({ missionId: "0123456789ab", leadThreadId: lead.threadId }),
);

/** Waits for a snapshot that matches, starting with the one a new client gets at once. */
const eventually = (matches: (snapshot: MissionsSnapshot) => boolean) =>
  Effect.flatMap(Missions.Missions, (missions) =>
    missions.watch.pipe(Stream.filter(matches), Stream.runHead, Effect.asVoid),
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

it.effect("a thread with no messages cannot lead a mission", () => {
  const world = makeWorld([lead]);
  world.empty(lead);
  return withMissions(
    world,
    Effect.gen(function* () {
      const refused = yield* createOne.pipe(Effect.flip);
      assert.include(refused.message, "needs a lead thread with messages");
      assert.deepEqual(world.tags(lead), []);
      assert.deepEqual((yield* listed).missions, []);
    }),
  );
});

it.effect("a mission is named for its lead's title, and its members' tags follow a rename", () => {
  const world = makeWorld([lead, localMember, laptopMember]);
  const renamed = "mission:0123456789ab:Two";
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      assert.equal(mission.name, "One");
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });

      world.retitle(lead, "Two");
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("rename");
      yield* until((snapshot) => snapshot.missions[0]?.name === "Two");
      assert.deepEqual(
        [world.tags(lead), world.tags(localMember), world.tags(laptopMember)],
        [[renamed], [renamed], [renamed]],
      );

      // A released member keeps the name the mission had when it left.
      yield* missions.releaseMember({ missionId: mission.missionId, member: laptopMember });
      assert.deepEqual(world.tags(laptopMember), ["mission-was:0123456789ab:Two"]);
    }),
  );
});

it.effect("an add that a rename overtakes joins under the new name", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      // The add has read the mission; the lead is renamed before its join is sent.
      world.beforeReleasesRead = Effect.suspend(() => {
        world.beforeReleasesRead = Effect.void;
        world.retitle(lead, "Two");
        return TestClock.adjust(Missions.REFRESH_INTERVAL).pipe(
          Effect.andThen(until((snapshot) => snapshot.missions[0]?.name === "Two")),
        );
      });
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      assert.deepEqual(world.tags(localMember), ["mission:0123456789ab:Two"]);
    }),
  );
});

it.effect("claims here that missed a rename take the name on the next sweep", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      // The server stops between renaming the mission and renaming its claims.
      world.afterMissionRenamed = Effect.suspend(() => {
        world.afterMissionRenamed = Effect.void;
        return Effect.die("stopped");
      });
      world.retitle(lead, "Two");
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => snapshot.missions[0]?.name === "Two");
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => snapshot.claims.every((claim) => claim.name === "Two"));
      assert.deepEqual(world.tags(localMember), ["mission:0123456789ab:Two"]);
    }),
  );
});

it.effect("a member's build without renames keeps the old name and stays reachable", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      yield* openSidebar;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      world.laptop.predatesRename = true;
      world.retitle(lead, "Two");
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilStarted("rename");
      // The next sweep's first call shows the one before it is done.
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilStarted("list");
      const snapshot = yield* listed;
      assert.equal(snapshot.missions[0]?.name, "Two");
      assert.equal(stateOf(snapshot, laptopMember), "active");
      assert.deepEqual(world.tags(laptopMember), [TAG]);
    }),
  );
});

it.effect("an archived lead shows as gone, as a deleted one does", () => {
  const world = makeWorld([lead]);
  return withMissions(
    world,
    Effect.gen(function* () {
      yield* createOne;
      world.archive(lead);
      assert.equal(stateOf(yield* listed, lead), "deleted");
    }),
  );
});

it.effect(
  "a new lead must be on the mission's machine, have messages and be in no other mission",
  () => {
    const otherLead = ref(HERE, "other-lead");
    const empty = ref(HERE, "empty");
    const world = makeWorld([lead, otherLead, empty, laptopMember]);
    world.empty(empty);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.create({ missionId: "ba9876543210", leadThreadId: otherLead.threadId });
        const refusalOf = (next: ScopedThreadRef) =>
          missions
            .setLead({ missionId: mission.missionId, lead: next, expectedLead: lead.threadId })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
        assert.include(yield* refusalOf(laptopMember), "must be a thread on that machine");
        assert.include(yield* refusalOf(empty), "needs a lead thread with messages");
        assert.include(yield* refusalOf(otherLead), "already in the mission");
        assert.deepEqual(membersOf((yield* listed).missions[0]), [["env-here/lead", "active"]]);
        assert.deepEqual(world.tags(lead), [TAG]);
      }),
    );
  },
);

it.effect("a member becomes the lead, keeps the others, and the mission takes its title", () => {
  const world = makeWorld([lead, localMember, laptopMember]);
  const renamed = "mission:0123456789ab:Two";
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      world.retitle(localMember, "Two");
      const promoted = yield* missions.setLead({
        missionId: mission.missionId,
        lead: localMember,
        expectedLead: lead.threadId,
      });
      assert.equal(promoted.name, "Two");
      assert.deepEqual(
        promoted.members.map((member) => [keyOf(member.ref), member.role, member.state]),
        [
          ["env-here/local", "lead", "active"],
          ["env-laptop/laptop", "member", "active"],
        ],
      );
      assert.deepEqual(world.tags(localMember), [renamed]);
      // The old lead leaves with the name the mission had.
      assert.deepEqual(world.tags(lead), [WAS_TAG]);
      // The laptop's claim stays; its tag takes the new name when the laptop is next asked.
      assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
    }),
  );
});

it.effect("two new leads asked at once: one wins, and every claim and tag follows it", () => {
  const [b, c] = [ref(HERE, "b"), ref(HERE, "c")];
  const world = makeWorld([lead, b, c]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      // Both read the mission, still led by `lead`, and their thread before either takes a lock.
      const bothRead = yield* Deferred.make<void>();
      let reads = 0;
      world.beforeShellRead = (threadId) => {
        if (threadId !== b.threadId && threadId !== c.threadId) return Effect.void;
        reads += 1;
        if (reads < 2) return Deferred.await(bothRead);
        world.beforeShellRead = () => Effect.void;
        return Deferred.succeed(bothRead, undefined);
      };
      const asked = yield* Effect.forEach(
        [b, c],
        (next) =>
          missions
            .setLead({ missionId: mission.missionId, lead: next, expectedLead: lead.threadId })
            .pipe(
              Effect.result,
              Effect.map((result) => [next, result] as const),
            ),
        { concurrency: "unbounded" },
      );
      const won = asked.filter(([, result]) => result._tag === "Success");
      assert.equal(won.length, 1);
      const [winner] = won[0]!;
      const loser = winner === b ? c : b;
      const [, refused] = asked.find(([next]) => next === loser)!;
      assert.deepEqual(
        refused._tag === "Failure" ? [refused.failure.reason, refused.failure.message] : [],
        ["lead-changed", "This mission already has a new lead."],
      );
      const snapshot = yield* listed;
      assert.deepEqual(membersOf(snapshot.missions[0]), [[keyOf(winner), "active"]]);
      assert.deepEqual(
        snapshot.claims.map((claim) => claim.threadId),
        [winner.threadId],
      );
      assert.deepEqual(world.tags(winner), [TAG]);
      assert.deepEqual(world.tags(loser), []);
      assert.deepEqual(world.tags(lead), [WAS_TAG]);
    }),
  );
});

it.effect("an ask that saw an older lead is refused, and one already done answers as done", () => {
  const [b, c] = [ref(HERE, "b"), ref(HERE, "c")];
  const world = makeWorld([lead, b, c]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const ask = (next: ScopedThreadRef) =>
        missions.setLead({ missionId: mission.missionId, lead: next, expectedLead: lead.threadId });
      yield* ask(b);
      // Another window, or a menu opened before B took over, still saw the old lead.
      const stale = yield* ask(c).pipe(Effect.flip);
      assert.equal(stale.reason, "lead-changed");
      // The answer to B's own ask was lost, and it asks again.
      const again = yield* ask(b);
      assert.deepEqual(membersOf(again), [[keyOf(b), "active"]]);
      assert.deepEqual([world.tags(b), world.tags(c)], [[TAG], []]);
    }),
  );
});

it.effect("a title read before a new lead took over does not rename the mission", () => {
  const fresh = ref(HERE, "fresh");
  const world = makeWorld([lead, fresh]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const store = yield* MissionStore.MissionStore;
      const mission = yield* createOne;
      world.retitle(fresh, "Fresh start");
      yield* missions.setLead({
        missionId: mission.missionId,
        lead: fresh,
        expectedLead: lead.threadId,
      });
      // A sweep that read the old lead's title before the swap writes it after.
      const named = yield* store.renameMission({
        missionId: mission.missionId,
        lead: lead.threadId,
        name: "Old title",
      });
      assert.equal(named, "Fresh start");
      assert.equal((yield* listed).missions[0]?.name, "Fresh start");
    }),
  );
});

const deleteRefusal = (missionId: string) =>
  Effect.flatMap(Missions.Missions, (missions) =>
    missions.deleteMission({ missionId }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );

it.effect("a mission with a member is not deleted; once released, its lead stays a thread", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      assert.equal(
        yield* deleteRefusal(mission.missionId),
        "Release this mission's threads before deleting it.",
      );
      assert.equal((yield* listed).missions.length, 1);
      yield* missions.releaseMember({ missionId: mission.missionId, member: localMember });
      yield* missions.deleteMission({ missionId: mission.missionId });
      const after = yield* listed;
      assert.deepEqual(after.missions, []);
      assert.deepEqual(after.claims, []);
      // The lead thread is kept, and its tag says which mission it led.
      assert.deepEqual(world.tags(lead), [WAS_TAG]);
      assert.include(yield* deleteRefusal(mission.missionId), "not found");
    }),
  );
});

it.effect("an add here that was under way when its mission was deleted makes no claim", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      // The add reads its thread, and waits there while the mission is deleted.
      const reading = yield* Deferred.make<void>();
      const letGo = yield* Deferred.make<void>();
      world.beforeShellRead = (threadId) => {
        if (threadId !== localMember.threadId) return Effect.void;
        world.beforeShellRead = () => Effect.void;
        return Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(letGo)));
      };
      const adding = yield* Effect.forkChild(
        missions.addMember({ missionId: mission.missionId, member: localMember }).pipe(Effect.flip),
      );
      yield* Deferred.await(reading);
      yield* missions.deleteMission({ missionId: mission.missionId });
      yield* Deferred.succeed(letGo, undefined);
      assert.include((yield* Fiber.join(adding)).message, "no longer exists");
      assert.deepEqual((yield* listed).claims, []);
      assert.deepEqual(world.tags(localMember), []);
    }),
  );
});

/** The claims this lead holds on the laptop, as the laptop itself keeps them. */
const laptopClaims = (world: ReturnType<typeof makeWorld>) =>
  Effect.suspend(() => world.laptop.claims!.list(LEAD_ON_LAPTOP));

it.effect("a join that landed unanswered is released once its deleted mission's sweep asks", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      // The laptop makes the claim, but its answers are lost, so the lead forgets the add.
      world.laptop.mode = "lostReply";
      yield* missions.addMember(member);
      yield* missions.forgetMember(member);
      // Nothing shows, so the mission can go.
      yield* missions.deleteMission({ missionId: mission.missionId });
      assert.equal((yield* laptopClaims(world)).length, 1);
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("release");
      assert.deepEqual(yield* laptopClaims(world), []);
      assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
      // A new add to it is refused at once, and so is its id.
      assert.include(
        yield* missions.addMember(member).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
        "not found",
      );
      assert.include(
        yield* createOne.pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
        "was deleted",
      );
    }),
  );
});

it.effect("a machine that never answered is still asked after the lead was down for weeks", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      world.laptop.mode = "lostReply";
      yield* missions.addMember(member);
      yield* missions.forgetMember(member);
      world.laptop.mode = "offline";
      yield* missions.deleteMission({ missionId: mission.missionId });
      world.whileStopped = TestClock.adjust(Duration.days(16));
    }),
    Effect.gen(function* () {
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("release");
      assert.deepEqual(yield* laptopClaims(world), []);
    }),
  );
});

it.effect("an add an earlier build forgot is found through the full-access link on delete", () => {
  const world = makeWorld([lead, laptopMember]);
  // The database as the build before tombstones left it: the add to the laptop was forgotten,
  // so nothing here says the laptop was ever sent anything.
  world.leadDatabase = Effect.gen(function* () {
    const earlier = Object.fromEntries(
      Object.entries(MissionStore.MIGRATIONS).filter(([id]) => Number(id.split("_")[0]) <= 5),
    );
    yield* Migrator.make({})({ loader: Migrator.fromRecord(earlier) });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO missions (mission_id, name, lead_thread_id, created_at)
      VALUES ('0123456789ab', 'One', ${lead.threadId}, '2026-01-01T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO claims (thread_id, mission_id, mission_name, role, owner, generation, claimed_at)
      VALUES (${lead.threadId}, '0123456789ab', 'One', 'lead', ${HERE}, 'g1', '2026-01-01')
    `;
  });
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      // The forgotten add did land on the laptop.
      yield* world.laptop.claims!.join(LEAD_ON_LAPTOP, {
        threadId: laptopMember.threadId,
        missionId: "0123456789ab",
        name: "One",
      });
      yield* missions.deleteMission({ missionId: "0123456789ab" });
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("release");
      assert.deepEqual(yield* laptopClaims(world), []);
    }),
  );
});

it.effect(
  "asks a deleted mission's machine on a backoff until it answers, then on a schedule",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        world.laptop.mode = "offline";
        yield* missions.deleteMission({ missionId: mission.missionId });
        // Which of the sweeps, every 15 seconds, asked the laptop.
        const askedAt = (seconds: number) =>
          Effect.gen(function* () {
            const asked: Array<number> = [];
            for (let at = 15; at <= seconds; at += 15) {
              const before = world.laptop.calls.length;
              yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
              if (world.laptop.calls.length > before) asked.push(at);
            }
            return asked;
          });
        // Before any answer: 15 seconds, then each wait doubles, up to 10 minutes.
        assert.deepEqual(yield* askedAt(1560), [15, 30, 60, 120, 240, 480, 960, 1560]);
        // It answers when next asked, 10 minutes on, and then 5 minutes after that.
        world.laptop.mode = "up";
        assert.deepEqual(yield* askedAt(600), [600]);
        assert.deepEqual(yield* askedAt(360), [300]);
      }),
    );
  },
);

it("schedules a deleted mission's checks: a capped backoff, then 5 min, 1 h, 6 h and daily", () => {
  const SECOND = 1000;
  const HOUR = 3600 * SECOND;
  let check = newTombstoneCheck(LAPTOP, 0);
  const misses: Array<number> = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    check = afterMiss(check, check.nextAt)!;
    misses.push(check.nextAt / SECOND);
  }
  assert.deepEqual(misses, [15, 45, 105, 225, 465, 945, 1545, 2145]);
  const checks: Array<number> = [];
  let answered: typeof check | null = afterAnswer(check, check.nextAt);
  const start = check.nextAt;
  while (answered !== null) {
    checks.push((answered.nextAt - start) / HOUR);
    answered = afterAnswer(answered, answered.nextAt);
  }
  assert.deepEqual(checks, [
    5 / 60,
    1,
    6,
    ...Array.from({ length: 14 }, (_, day) => (day + 1) * 24),
  ]);
});

it.effect(
  "a deleted mission's claim is released by a list asked for another mission's sake",
  () => {
    const otherLead = ref(HERE, "other-lead");
    const otherMember = ref(LAPTOP, "laptop-other");
    const world = makeWorld([lead, otherLead, laptopMember, otherMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const store = yield* MissionStore.MissionStore;
        const mission = yield* createOne;
        const other = yield* missions.create({
          missionId: "bbbbbbbbbbbb",
          leadThreadId: otherLead.threadId,
        });
        yield* missions.addMember({ missionId: other.missionId, member: otherMember });
        yield* missions.deleteMission({ missionId: mission.missionId });
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* world.untilAnswered("list");
        // Its checks run out, as 14 days after that answer, so no check asks the laptop again.
        yield* store.setTombstoneCheck(LAPTOP, null);
        assert.deepEqual(yield* store.tombstoneChecks, []);
        // A join still on its way lands on the laptop after all that.
        yield* world.laptop.claims!.join(LEAD_ON_LAPTOP, {
          threadId: laptopMember.threadId,
          missionId: mission.missionId,
          name: "One",
        });
        // A client opens the sidebar, which lists the laptop for the other mission's member.
        yield* openSidebar;
        yield* world.untilAnswered("release");
        assert.deepEqual(
          (yield* laptopClaims(world)).map((claim) => claim.missionId),
          [other.missionId],
        );
      }),
    );
  },
);

it.effect("a release forgotten before delete is sent once its machine is back", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      yield* missions.addMember(member);
      world.laptop.mode = "offline";
      yield* missions.releaseMember(member);
      yield* missions.forgetMember(member);
      yield* missions.deleteMission({ missionId: mission.missionId });
      assert.equal((yield* laptopClaims(world)).length, 1);
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("release");
      assert.deepEqual(yield* laptopClaims(world), []);
    }),
  );
});

it.effect("a release goes to the live claim, not to a refusal the view hides behind it", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const store = yield* MissionStore.MissionStore;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      yield* missions.addMember(member);
      // An older add of the same thread was refused, and its row is still kept.
      yield* store.setPendingAdd({
        ...laptopMember,
        missionId: mission.missionId,
        intentId: "older-add",
        linkId: "",
        addedAt: "",
        refusal: "Laptop refused.",
      });
      assert.equal(stateOf(yield* listed, laptopMember), "active");
      yield* missions.releaseMember(member);
      assert.deepEqual(yield* laptopClaims(world), []);
      assert.equal(stateOf(yield* listed, laptopMember), undefined);
    }),
  );
});

it.effect("a member deleted while the server was stopped is let go when it starts", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      world.whileStopped = Effect.sync(() => world.remove(localMember));
    }),
    Effect.gen(function* () {
      yield* eventually((snapshot) =>
        snapshot.claims.every((claim) => claim.threadId !== localMember.threadId),
      );
      assert.deepEqual(
        (yield* listed).claims.map((claim) => claim.threadId),
        [lead.threadId],
      );
    }),
  );
});

it.effect("a member deleted here drops out of its mission and does not hold off delete", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      world.remove(localMember);
      assert.equal(stateOf(yield* listed, localMember), undefined);
      yield* missions.deleteMission({ missionId: mission.missionId });
      assert.deepEqual(yield* listed, { ...(yield* listed), missions: [], claims: [] });
    }),
  );
});

it.effect(
  "deleting a member thread here lets go of its claim; a deleted lead keeps its own",
  () => {
    const world = makeWorld([lead, localMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: localMember });
        // As a delete, or T3 dropping an unused side chat, reports them.
        yield* releaseDeletedThreads(
          Stream.make(
            { type: "thread.deleted", threadId: localMember.threadId },
            { type: "thread.deleted", threadId: lead.threadId },
          ),
        );
        assert.deepEqual(
          (yield* listed).claims.map((claim) => claim.threadId),
          [lead.threadId],
        );
        // A member's tag says where it was, as on release.
        assert.deepEqual(world.tags(localMember), ["mission-was:0123456789ab:One"]);
      }),
    );
  },
);

it.effect("a mission is not deleted while an add to another machine waits for its answer", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      world.laptop.mode = "lostReply";
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      assert.equal(stateOf(yield* listed, laptopMember), "add-pending");
      assert.equal(
        yield* deleteRefusal(mission.missionId),
        "Release this mission's threads before deleting it.",
      );
      assert.deepEqual(world.tags(lead), [TAG]);
    }),
  );
});

it.effect("a deleted lead is replaced by a thread with messages on this machine", () => {
  const fresh = ref(HERE, "fresh");
  const world = makeWorld([lead, fresh]);
  world.retitle(fresh, "Fresh start");
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      world.remove(lead);
      assert.equal(stateOf(yield* listed, lead), "deleted");
      const replaced = yield* missions.setLead({
        missionId: mission.missionId,
        lead: fresh,
        expectedLead: lead.threadId,
      });
      assert.equal(replaced.name, "Fresh start");
      assert.deepEqual(membersOf(replaced), [["env-here/fresh", "active"]]);
      assert.deepEqual(world.tags(fresh), ["mission:0123456789ab:Fresh start"]);
    }),
  );
});

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
          .create({ missionId: first.missionId, leadThreadId: localMember.threadId })
          .pipe(Effect.flip);
        assert.equal(sameId.message, "Another mission already uses this id.");
        const held = yield* missions
          .create({ missionId: "ba9876543210", leadThreadId: localMember.threadId })
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
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      // The join is sent again at once, and that reply is lost as well.
      assert.deepEqual(yield* world.nextCalls(2), ["join", "join"]);
      assert.equal(stateOf(yield* listed, laptopMember), "add-pending");

      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => stateOf(snapshot, laptopMember) === "active");
      // Every one of those joins found the claim the first one made.
      assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
    }),
  );
});

it.effect(
  "an add that timed out is sent again after a restart, so a join that lands late is seen",
  () => {
    const world = makeWorld([lead, laptopMember]);
    const member = { missionId: "0123456789ab", member: laptopMember };
    return withMissions(
      world,
      Effect.gen(function* () {
        yield* createOne;
        world.laptop.mode = "hanging";
        const adding = yield* Effect.forkChild((yield* Missions.Missions).addMember(member));
        yield* TestClock.adjust(Missions.MEMBER_CALL_DEADLINE);
        yield* Fiber.await(adding);
        world.laptop.mode = "up";
      }),
      Effect.gen(function* () {
        // The laptop answers the restarted lead, and the join that timed out has not landed there.
        yield* openSidebar;
        yield* world.untilAnswered("list");
        // Only now does that join land.
        yield* world.laptop.claims!.join(LEAD_ON_LAPTOP, {
          threadId: laptopMember.threadId,
          missionId: member.missionId,
          name: "One",
        });
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        assert.equal(stateOf(yield* listed, laptopMember), "active");
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
        assert.deepEqual(world.tags(laptopMember), [TAG]);
      }),
    );
  },
);

it.effect("an add the laptop turns down once it is back says why, until it is dismissed", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      world.laptop.mode = "offline";
      yield* missions.addMember(member);
      yield* until((snapshot) => stateOf(snapshot, laptopMember) === "add-pending");
      // Another lead takes the thread before the laptop is back.
      yield* world.laptop.claims!.join("link:another-lead", {
        threadId: laptopMember.threadId,
        missionId: "ffffffffffff",
        name: "Theirs",
      });
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => stateOf(snapshot, laptopMember) === "add-refused");
      const refused = (yield* listed).missions[0]!.members[1]!;
      assert.include(
        refused.detail,
        'Laptop refused: This thread is already in the mission "Theirs"',
      );

      const sent = world.laptop.calls.length;
      yield* missions.releaseMember(member);
      assert.equal(stateOf(yield* listed, laptopMember), undefined);
      assert.equal(world.laptop.calls.length, sent);
    }),
  );
});

it.effect.each([
  { waitsOn: "an add", sentBefore: ["join", "join"], settled: [] },
  { waitsOn: "a release", sentBefore: ["join", "release", "release"], settled: [] },
] as const)(
  "forgetting $waitsOn that still waits removes the row and stops asking, and the thread can be added again",
  ({ waitsOn, sentBefore, settled }) => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        yield* openSidebar;
        const mission = yield* createOne;
        const member = { missionId: mission.missionId, member: laptopMember };
        if (waitsOn === "a release") {
          yield* missions.addMember(member);
          // Only a thread that waits on its machine can be forgotten.
          yield* missions.forgetMember(member).pipe(Effect.flip);
        }
        world.laptop.mode = "offline";
        yield* waitsOn === "an add" ? missions.addMember(member) : missions.releaseMember(member);
        // What was sent, and sent again at once.
        assert.deepEqual(yield* world.nextCalls(sentBefore.length), [...sentBefore]);

        yield* missions.forgetMember(member);
        assert.equal(stateOf(yield* listed, laptopMember), undefined);
        world.laptop.mode = "up";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* missions.addMember(member);
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        // The laptop is listed again only now, after the new add, and nothing was sent in between.
        yield* world.untilAnswered("list");
        if (settled.length > 0) yield* world.untilAnswered("list");
        assert.deepEqual(world.laptop.calls, [...sentBefore, ...settled, "join", "list"]);
        assert.equal(stateOf(yield* listed, laptopMember), "active");
        assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
      }),
    );
  },
);

it.effect("an add cut off after the laptop made the claim is still there after a restart", () => {
  const world = makeWorld([lead, laptopMember]);
  const member = { missionId: "0123456789ab", member: laptopMember };
  return withMissions(
    world,
    Effect.gen(function* () {
      yield* createOne;
      world.laptop.mode = "actsThenHangs";
      const adding = yield* Effect.forkChild((yield* Missions.Missions).addMember(member));
      yield* world.untilActed("join");
      // The client that asked goes away before any reply or timeout.
      yield* Fiber.interrupt(adding);
      world.laptop.mode = "offline";
    }),
    Effect.gen(function* () {
      assert.equal(stateOf(yield* listed, laptopMember), "add-pending");
      world.laptop.mode = "up";
      yield* eventually((snapshot) => stateOf(snapshot, laptopMember) === "active");
      assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);
    }),
  );
});

it.effect("a join sent again after the thread left is turned down, so the thread stays out", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      world.laptop.mode = "lostReply";
      yield* missions.addMember(member);
      // The join landed twice over: the add, and the copy sent again at once. No reply got back.
      yield* world.untilActed("join");
      yield* world.untilActed("join");
      assert.equal((yield* world.laptop.claims!.list(LEAD_ON_LAPTOP)).length, 1);

      // The laptop's user takes the thread out, and the lead still sends the join again.
      yield* world.laptop.claims!.leaveHere(laptopMember.threadId);
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilActed("join");
      assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
      assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
      yield* eventually((snapshot) => stateOf(snapshot, laptopMember) === undefined);

      // A new add by the user is a new intent, so it brings the thread in again.
      yield* missions.addMember(member);
      assert.equal(stateOf(yield* listed, laptopMember), "active");
    }),
  );
});

it.effect("forgetting a thread in one mission leaves another mission's claim on it alone", () => {
  const otherLead = ref(HERE, "other-lead");
  const world = makeWorld([lead, otherLead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      yield* openSidebar;
      const one = yield* createOne;
      const two = yield* missions.create({
        missionId: "ba9876543210",
        leadThreadId: otherLead.threadId,
      });
      yield* missions.addMember({ missionId: one.missionId, member: laptopMember });
      world.laptop.mode = "offline";
      yield* missions.addMember({ missionId: two.missionId, member: laptopMember });
      assert.deepEqual(membersOf((yield* listed).missions[1]), [
        ["env-here/other-lead", "active"],
        ["env-laptop/laptop", "add-pending"],
      ]);

      yield* missions.forgetMember({ missionId: two.missionId, member: laptopMember });
      const after = yield* listed;
      assert.deepEqual(membersOf(after.missions[1]), [["env-here/other-lead", "active"]]);
      assert.equal(stateOf(after, laptopMember), "offline");
      // The laptop still holds a known claim, so it is still asked.
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* eventually((snapshot) => stateOf(snapshot, laptopMember) === "active");
    }),
  );
});

it.effect(
  "a join that lands after its add was forgotten shows again when the laptop is asked",
  () => {
    const kept = ref(LAPTOP, "kept");
    const world = makeWorld([lead, kept, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        yield* openSidebar;
        const mission = yield* createOne;
        const member = { missionId: mission.missionId, member: laptopMember };
        // Another member there keeps the laptop among the machines the lead asks.
        yield* missions.addMember({ missionId: mission.missionId, member: kept });
        world.laptop.mode = "offline";
        yield* missions.addMember(member);
        yield* missions.forgetMember(member);
        assert.equal(stateOf(yield* listed, laptopMember), undefined);

        // The claim is real once the join lands, so the lead lists it again.
        yield* world.laptop.claims!.join(LEAD_ON_LAPTOP, {
          threadId: laptopMember.threadId,
          missionId: mission.missionId,
          name: mission.name,
        });
        world.laptop.mode = "up";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* eventually((snapshot) => stateOf(snapshot, laptopMember) === "active");
      }),
    );
  },
);

it.effect(
  "a link the laptop no longer accepts is no answer, and a refusal by its tool is one",
  () => {
    const second = ref(LAPTOP, "second");
    const world = makeWorld([lead, laptopMember, second, ref(LAPTOP, "third")]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        const member = { missionId: mission.missionId, member: laptopMember };
        yield* missions.addMember(member);
        yield* missions.addMember({ missionId: mission.missionId, member: second });

        world.laptop.mode = "revoked";
        yield* missions.releaseMember(member);
        const revoked = yield* listed;
        assert.equal(stateOf(revoked, laptopMember), "release-pending");
        assert.equal(stateOf(revoked, second), "offline");
        yield* missions.forgetMember(member);
        assert.equal(stateOf(yield* listed, laptopMember), undefined);

        world.laptop.mode = "denies";
        const third = { missionId: mission.missionId, member: ref(LAPTOP, "third") };
        const refused = yield* missions.addMember(third).pipe(Effect.flip);
        assert.include(refused.message, "Laptop refused: This link may change only threads");
        assert.equal(stateOf(yield* listed, third.member), undefined);
      }),
    );
  },
);

it.effect("an add made under one link is not sent again once the machine is linked again", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      world.laptop.mode = "lostReply";
      yield* missions.addMember(member);
      // The join landed, and so did the copy sent again at once. No reply got back.
      yield* world.untilActed("join");
      yield* world.untilActed("join");

      // The laptop revokes the link, and its user takes the thread out of the mission.
      world.laptop.mode = "revoked";
      yield* world.laptop.claims!.leaveHere(laptopMember.threadId);
      // The two machines are linked again with full access: a new link, a new session there.
      world.laptop.linkedAt = "2026-02-01T00:00:00.000Z";
      world.laptop.session = "lead-session-after-relink";
      world.laptop.mode = "up";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* eventually((snapshot) => stateOf(snapshot, laptopMember) !== "add-pending");

      const row = (yield* listed).missions[0]!.members[1];
      assert.equal(row?.state, "add-refused");
      assert.include(row?.detail, "The link to Laptop was made again since this add");
      // Reading the laptop's claims is fine. No join went out after the two at the start.
      assert.equal(world.laptop.calls.filter((kind) => kind === "join").length, 2);
      assert.deepEqual(yield* world.laptop.claims!.list("link:lead-session-after-relink"), []);
      assert.deepEqual(world.tags(laptopMember), [WAS_TAG]);
    }),
  );
});

it.effect("an add that waited a week is not sent again", () => {
  const world = makeWorld([lead, laptopMember]);
  const member = { missionId: "0123456789ab", member: laptopMember };
  return withMissions(
    world,
    Effect.gen(function* () {
      yield* createOne;
      world.laptop.mode = "offline";
      yield* (yield* Missions.Missions).addMember(member);
      assert.deepEqual(yield* world.nextCalls(2), ["join", "join"]);
      world.laptop.mode = "up";
      world.whileStopped = TestClock.adjust(Duration.days(Missions.PENDING_ADD_DAYS + 1));
    }),
    Effect.gen(function* () {
      yield* eventually((snapshot) => stateOf(snapshot, laptopMember) !== "add-pending");
      const row = (yield* listed).missions[0]!.members[1];
      assert.equal(row?.state, "add-refused");
      assert.include(row?.detail, "waited more than 7 days");
      // Reading the laptop's claims is fine. No join went out after the two at the start.
      assert.equal(world.laptop.calls.filter((kind) => kind === "join").length, 2);
      assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
    }),
  );
});

const InSecondRelease = Context.Reference<boolean>("test/InSecondRelease", {
  defaultValue: () => false,
});

it.effect(
  "a release left waiting after another client's release got through can be forgotten",
  () => {
    const world = makeWorld([lead, laptopMember]);
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        const member = { missionId: mission.missionId, member: laptopMember };
        yield* missions.addMember(member);
        world.laptop.mode = "heldThenOffline";
        const first = yield* Effect.forkChild(missions.releaseMember(member));
        assert.deepEqual(yield* world.nextCalls(2), ["join", "release"]);
        // A second client releases the member too. It reads the claim the first has yet to drop.
        const read = yield* Deferred.make<void>();
        world.afterKnownClaimsRead = Effect.flatMap(InSecondRelease, (second) =>
          second ? Effect.asVoid(Deferred.succeed(read, undefined)) : Effect.void,
        );
        const second = yield* Effect.forkChild(
          missions.releaseMember(member).pipe(Effect.provideService(InSecondRelease, true)),
        );
        yield* Deferred.await(read);
        // The laptop answers the first release and is gone before the second is sent.
        yield* Deferred.succeed(world.laptop.letGo!, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);

        assert.equal(stateOf(yield* listed, laptopMember), "release-pending");
        yield* missions.forgetMember(member);
        assert.equal(stateOf(yield* listed, laptopMember), undefined);
      }),
    );
  },
);

it.effect("a link this machine can no longer use leaves its members as last known", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const until = yield* openSidebar;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      world.laptop.linkExpired = true;
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* until((snapshot) => stateOf(snapshot, laptopMember) === "offline");
      // Nothing was sent over a link that had run out.
      assert.deepEqual(world.laptop.calls, ["join"]);
      const refused = yield* missions
        .addMember({ missionId: mission.missionId, member: ref(LAPTOP, "another") })
        .pipe(Effect.flip);
      assert.include(refused.message, "The link to Laptop expired");
    }),
  );
});

it.effect("a new watcher never gets an older snapshot after a newer one", () => {
  const [a, b, c] = [ref(HERE, "a"), ref(HERE, "b"), ref(HERE, "c")];
  const world = makeWorld([lead, a, b, c]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      for (const member of [a, b, c]) {
        yield* missions.addMember({ missionId: mission.missionId, member });
      }
      // One snapshot is held open after it read the members and before it reads the missions.
      const held = yield* Deferred.make<void>();
      const letGo = yield* Deferred.make<void>();
      world.beforeMissionsRead = Effect.suspend(() => {
        world.beforeMissionsRead = Effect.void;
        return Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(letGo)));
      });
      yield* missions.leaveHere(c.threadId);
      yield* Deferred.await(held);
      // A member leaves while that snapshot is open, and a client starts watching.
      yield* missions.leaveHere(b.threadId);
      const seen = yield* Queue.unbounded<ReturnType<typeof membersOf>>();
      yield* missions.watch.pipe(
        Stream.runForEach((snapshot) => Queue.offer(seen, membersOf(snapshot.missions[0]))),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(letGo, undefined);
      const withoutB = [
        ["env-here/lead", "active"],
        ["env-here/a", "active"],
      ];
      assert.deepEqual(yield* Queue.take(seen), withoutB);
      yield* missions.leaveHere(a.threadId);
      assert.deepEqual(yield* Queue.take(seen), [["env-here/lead", "active"]]);
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

it.effect("a thread added again keeps its claim when the release sent before arrives late", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      const member = { missionId: mission.missionId, member: laptopMember };
      yield* missions.addMember(member);
      const [first] = yield* world.laptop.claims!.list(LEAD_ON_LAPTOP);
      world.laptop.mode = "hanging";
      const releasing = yield* Effect.forkChild(missions.releaseMember(member));
      yield* TestClock.adjust(Missions.MEMBER_CALL_DEADLINE);
      yield* Fiber.join(releasing);
      // The release, and the retry that follows it at once and hangs as well. The retry at the
      // next interval is refused a connection, so the laptop still holds the claim.
      world.laptop.mode = "offline";
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      assert.deepEqual(yield* world.nextCalls(4), ["join", "release", "release", "release"]);
      assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), [first!]);
      assert.equal(stateOf(yield* listed, laptopMember), "release-pending");

      world.laptop.mode = "up";
      yield* missions.addMember(member);
      // Only now does the release that timed out reach the laptop.
      yield* world.laptop.claims!.release(LEAD_ON_LAPTOP, {
        threadId: laptopMember.threadId,
        missionId: mission.missionId,
        generation: first!.generation,
      });
      const [again] = yield* world.laptop.claims!.list(LEAD_ON_LAPTOP);
      assert.notEqual(again?.generation, first!.generation);
      assert.deepEqual(world.tags(laptopMember), [TAG]);
      assert.equal(stateOf(yield* listed, laptopMember), "active");
    }),
  );
});

it.effect(
  "after a restart, an offline machine's members are still listed and can be released",
  () => {
    const world = makeWorld([lead, laptopMember]);
    const member = { missionId: "0123456789ab", member: laptopMember };
    return withMissions(
      world,
      Effect.gen(function* () {
        yield* createOne;
        yield* (yield* Missions.Missions).addMember(member);
        world.laptop.mode = "offline";
      }),
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const until = yield* openSidebar;
        assert.equal(stateOf(yield* listed, laptopMember), "offline");
        yield* missions.releaseMember(member);
        assert.equal(stateOf(yield* listed, laptopMember), "release-pending");

        world.laptop.mode = "up";
        yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
        yield* until((snapshot) => stateOf(snapshot, laptopMember) === undefined);
        assert.deepEqual(yield* world.laptop.claims!.list(LEAD_ON_LAPTOP), []);
      }),
    );
  },
);

it.effect("a mission whose lead thread was deleted stays, and its members can be released", () => {
  const world = makeWorld([lead, localMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: localMember });
      world.remove(lead);
      assert.deepEqual(membersOf((yield* listed).missions[0]), [
        ["env-here/lead", "deleted"],
        ["env-here/local", "active"],
      ]);
      yield* missions.releaseMember({ missionId: mission.missionId, member: localMember });
      assert.deepEqual(world.tags(localMember), [WAS_TAG]);
      assert.deepEqual(membersOf((yield* listed).missions[0]), [["env-here/lead", "deleted"]]);
    }),
  );
});

it.effect("many watching clients share one sweep, at the start and on each interval", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const mission = yield* createOne;
      yield* (yield* Missions.Missions).addMember({
        missionId: mission.missionId,
        member: laptopMember,
      });
      yield* Effect.forEach([1, 2, 3, 4, 5], () => openSidebar, { concurrency: "unbounded" });
      assert.deepEqual(yield* world.nextCalls(2), ["join", "list"]);
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      assert.deepEqual(yield* world.nextCalls(1), ["list"]);
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      assert.deepEqual(yield* world.nextCalls(1), ["list"]);
      assert.deepEqual(world.laptop.calls, ["join", "list", "list", "list"]);
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

const HEADER =
  'You are the lead of the mission "One". You orchestrate its threads. If the user asks for something different in a message, the message wins.';
const turnContextOf = (thread: ScopedThreadRef) =>
  Effect.flatMap(MissionTurnContexts.MissionTurnContexts, (contexts) =>
    contexts.read(thread.threadId),
  );

it.effect(
  "a lead's turn gets its prompt and members' status; other threads, and an old lead, get none",
  () => {
    const world = makeWorld([lead, localMember, laptopMember]);
    world.settings.missionDefaultPrompt = "Review every pull request.";
    return withMissions(
      world,
      Effect.gen(function* () {
        const missions = yield* Missions.Missions;
        const mission = yield* createOne;
        yield* missions.addMember({ missionId: mission.missionId, member: localMember });
        yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
        world.shell(localMember, {
          status: "waiting",
          activeRunId: "run-1",
          pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: "2026-01-01" },
        });
        world.shell(laptopMember, { status: "running" });
        yield* listed;
        yield* world.untilAnswered("list");

        assert.deepEqual(yield* turnContextOf(lead), {
          prompt: `${HEADER}\n\nReview every pull request.`,
          status: [
            "Status: 2 members. 1 need you (awaiting input, pending approval), 0 failed, 1 working, 0 idle, 0 offline.",
            "Needs attention: local on this machine (web), awaiting input.",
            "For titles and the full list, call t3_mission_roster.",
          ].join("\n"),
        });
        assert.isUndefined(yield* turnContextOf(localMember));

        yield* missions.setPrompt({ missionId: mission.missionId, prompt: "  Ship it.  " });
        assert.equal((yield* turnContextOf(lead))?.prompt, `${HEADER}\n\nShip it.`);
        assert.equal((yield* listed).missions[0]?.prompt, "Ship it.");
        yield* missions.setPrompt({ missionId: mission.missionId, prompt: "" });
        assert.equal(
          (yield* turnContextOf(lead))?.prompt,
          `${HEADER}\n\nReview every pull request.`,
        );

        yield* missions.setLead({
          missionId: mission.missionId,
          lead: localMember,
          expectedLead: lead.threadId,
        });
        assert.isUndefined(yield* turnContextOf(lead));
        assert.isDefined(yield* turnContextOf(localMember));
      }),
    );
  },
);

it.effect("with no client watching, a lead still hears its members on another machine", () => {
  const world = makeWorld([lead, laptopMember]);
  return withMissions(
    world,
    Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const mission = yield* createOne;
      yield* missions.addMember({ missionId: mission.missionId, member: laptopMember });
      const heard = yield* missions.remoteChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("list");
      world.shell(laptopMember, {
        status: "waiting",
        pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "2026-01-01" },
      });
      yield* TestClock.adjust(Missions.REFRESH_INTERVAL);
      yield* world.untilAnswered("list");
      assert.deepEqual(
        [...(yield* Fiber.join(heard))].map((change) => change.status),
        ["idle", "pending-approval"],
      );
      const [row] = yield* missions.roster(mission.missionId);
      assert.deepEqual(row, {
        ref: laptopMember,
        machine: "Laptop",
        project: "api",
        status: "pending-approval",
        title: "One",
      });
    }),
  );
});
