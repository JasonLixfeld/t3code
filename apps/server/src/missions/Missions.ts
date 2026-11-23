import {
  type EnvironmentId,
  isMissionTag,
  type Mission,
  MissionError,
  type MissionMember,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  type MissionsSnapshot,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { MissionClaimResult } from "../mcp/toolkits/mission/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { MissionClaims } from "./MissionClaims.ts";
import {
  type MissionClaim,
  type MissionRecord,
  MissionStore,
  type PendingRelease,
} from "./MissionStore.ts";

/** How long a lead waits on a member's machine before it treats the outcome as unknown. */
export const MEMBER_CALL_DEADLINE = Duration.seconds(10);
/** How often a lead asks its linked machines again, while a client watches or a release waits. */
export const REFRESH_INTERVAL = Duration.seconds(15);

export class Missions extends Context.Service<
  Missions,
  {
    /** The Missions here and the links that can reach member threads, now and after each change. */
    readonly watch: Stream.Stream<MissionsSnapshot>;
    /** Starts a Mission led by a thread here. Asking again with the same id returns that Mission. */
    readonly create: (input: {
      readonly missionId: string;
      readonly name: string;
      readonly leadThreadId: ThreadId;
    }) => Effect.Effect<Mission, MissionError>;
    readonly addMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /** Leaves the release pending when the member's machine cannot be reached. */
    readonly releaseMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /**
     * The local user frees a thread on this machine from its Mission, whichever machine leads it.
     * The lead thread of a Mission here stays.
     */
    readonly leaveHere: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
  }
>()("t3/missions/Missions") {}

/** The member's machine did not answer in time: the call may or may not have happened there. */
class Unreachable extends Schema.TaggedError<Unreachable>()("MissionMemberUnreachable", {
  label: Schema.String,
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

type ClaimCall =
  | {
      readonly kind: "join";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly name: string;
    }
  | {
      readonly kind: "release";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly generation: string;
    }
  | { readonly kind: "list" };

/** The claims a machine holds for this lead, as it last said. */
interface Machine {
  readonly claims: ReadonlyArray<MissionClaim>;
  readonly reachable: boolean;
}

const memberKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
const sameSnapshot = (a: MissionsSnapshot | undefined, b: MissionsSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const claims = yield* MissionClaims;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const background = yield* Effect.scope;
  // One call at a time per machine, so what is remembered of it follows the order of its answers.
  const machineLocks = yield* KeyedLock.make<EnvironmentId>();
  // Empty after a restart: a machine counts as away until it answers again.
  const answering = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const watchers = yield* Ref.make(0);

  const setAnswering = (environmentId: EnvironmentId, answers: boolean) =>
    Ref.update(answering, (current) => {
      const next = new Set(current);
      if (answers) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });

  const machines = Effect.gen(function* () {
    const reachable = yield* Ref.get(answering);
    const held = new Map<EnvironmentId, Machine>([
      [here, { claims: yield* store.claimsOf(here), reachable: true }],
    ]);
    for (const [environmentId, known] of yield* store.knownMachines) {
      held.set(environmentId, { claims: known, reachable: reachable.has(environmentId) });
    }
    return held;
  });

  const missionLinks = Effect.gen(function* () {
    if (!(yield* links.enabled)) return [];
    const names = yield* links.names;
    return yield* Effect.forEach(names, (name) =>
      links.get(name.environmentId).pipe(
        Effect.map((link) => ({
          environmentId: name.environmentId,
          label: name.label,
          fullAccess: Option.isSome(link) && link.value.access === "full-access",
        })),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Mission links could not be read", error).pipe(Effect.as([])),
    ),
  );

  /**
   * A Mission's members are computed, never stored: the claims each machine holds for it. A claim
   * for a Mission this lead does not know is left alone, because a lead restored from a backup
   * would otherwise free valid members. Claims made under an earlier link session stop appearing
   * here after a re-pair; the member's own Leave frees those.
   */
  const missionView = Effect.fn("Missions.view")(function* (
    mission: MissionRecord,
    held: ReadonlyMap<EnvironmentId, Machine>,
    pending: ReadonlyArray<PendingRelease>,
  ) {
    const lead = { environmentId: here, threadId: mission.leadThreadId };
    // A lead thread that cannot be read is not taken for a deleted one.
    const leadDeleted = yield* threads.getThreadShell(mission.leadThreadId).pipe(
      Effect.map((shell) => shell === null || shell.deletedAt !== null),
      Effect.orElseSucceed(() => false),
    );
    const members = new Map<string, MissionMember>([
      [memberKey(lead), { ref: lead, role: "lead", state: leadDeleted ? "deleted" : "active" }],
    ]);
    const releasing = pending.filter((release) => release.missionId === mission.missionId);
    for (const [environmentId, machine] of held) {
      for (const claim of machine.claims) {
        if (claim.missionId !== mission.missionId || claim.role === "lead") continue;
        const ref = { environmentId, threadId: claim.threadId };
        const isReleasing = releasing.some(
          (release) =>
            memberKey(release) === memberKey(ref) && release.generation === claim.generation,
        );
        members.set(memberKey(ref), {
          ref,
          role: "member",
          state: isReleasing ? "release-pending" : machine.reachable ? "active" : "offline",
        });
      }
    }
    return {
      missionId: mission.missionId,
      name: mission.name,
      createdAt: mission.createdAt,
      members: [...members.values()],
    } satisfies Mission;
  });

  const snapshot = Effect.gen(function* () {
    const held = yield* machines;
    const pending = yield* store.pendingReleases;
    return {
      missions: yield* Effect.forEach(yield* store.missions, (mission) =>
        missionView(mission, held, pending),
      ),
      links: yield* missionLinks,
      claims: (yield* store.allClaims).map(({ threadId, missionId, name }) => ({
        threadId,
        missionId,
        name,
      })),
    } satisfies MissionsSnapshot;
  });

  // One fiber at a time computes and compares, so watchers get snapshots in the order they were read.
  const publishing = yield* Semaphore.make(1);
  const published = yield* Ref.make<MissionsSnapshot | undefined>(undefined);
  const views = yield* PubSub.unbounded<MissionsSnapshot>();
  /** The snapshot now. Watchers hear of it only when it differs from the one before. */
  const publish = Effect.gen(function* () {
    const next = yield* snapshot;
    const last = yield* Ref.getAndSet(published, next);
    if (!sameSnapshot(last, next)) yield* PubSub.publish(views, next);
    return next;
  }).pipe(publishing.withPermits(1));
  const storeChanges = yield* PubSub.subscribe(store.changes);
  yield* Stream.fromSubscription(storeChanges).pipe(
    Stream.runForEach(() => publish),
    Effect.forkIn(background),
  );

  const linkTo = Effect.fn("Missions.linkTo")(function* (environmentId: EnvironmentId) {
    if (!(yield* links.enabled)) return yield* fail(PeerLinks.LINKED_ENVIRONMENTS_OFF);
    const link = yield* links.get(environmentId).pipe(Effect.catch((error) => fail(error.message)));
    if (Option.isNone(link)) {
      return yield* fail(
        "This machine has no link to the thread's machine. Link them in Settings → Connections first.",
      );
    }
    const { label, access } = link.value;
    if (access !== "full-access") {
      return yield* fail(
        `The link to ${label} has ${access} access. A link below full access may change only threads it started, so relink ${label} with full access to use its threads in a mission.`,
      );
    }
    return label;
  });

  /**
   * Runs a claim call on the member's own machine. A refusal there, or a link that may not make
   * the call, is a MissionError; no answer in time is Unreachable, an outcome nobody knows yet.
   */
  const onMember = Effect.fn("Missions.onMember")(function* (
    environmentId: EnvironmentId,
    call: ClaimCall,
  ): Effect.fn.Return<ReadonlyArray<MissionClaim>, MissionError | Unreachable> {
    if (environmentId === here) {
      switch (call.kind) {
        case "join":
          return [yield* claims.join(here, call)];
        case "release":
          yield* claims.release(here, call);
          return [];
        case "list":
          return yield* claims.list(here);
      }
    }
    const label = yield* linkTo(environmentId).pipe(
      Effect.tapError(() => setAnswering(environmentId, false)),
    );
    const answered = yield* peers
      .call({
        environmentId,
        tool: "t3_mission_tag",
        arguments: { ...call },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: MissionClaimResult,
      })
      .pipe(Effect.timeoutOption(MEMBER_CALL_DEADLINE), Effect.result);
    // Transport and link failures say nothing about what happened there; refusals do.
    const unreachable = Result.isFailure(answered)
      ? answered.failure.code === "orchestration_error"
        ? answered.failure.message
        : undefined
      : Option.isNone(answered.success)
        ? `${label} did not answer in time.`
        : undefined;
    yield* setAnswering(environmentId, unreachable === undefined);
    if (unreachable !== undefined) return yield* new Unreachable({ label, message: unreachable });
    if (Result.isFailure(answered)) {
      return yield* fail(`${label} refused: ${answered.failure.message}`);
    }
    return Option.getOrThrow(answered.success).claims;
  });

  /** Call only under the machine's lock. An answer settles the release, whatever it found there. */
  const sendRelease = Effect.fn("Missions.sendRelease")(function* (release: PendingRelease) {
    yield* onMember(release.environmentId, {
      kind: "release",
      threadId: release.threadId,
      missionId: release.missionId,
      generation: release.generation,
    });
    yield* store.clearPendingRelease(release);
    yield* store.forgetClaim(release);
  });

  const refreshMachine = (environmentId: EnvironmentId, discover: boolean) =>
    machineLocks.withLock(
      environmentId,
      Effect.gen(function* () {
        for (const release of yield* store.pendingReleases) {
          if (release.environmentId === environmentId) yield* sendRelease(release);
        }
        if (!discover) return;
        yield* store.setKnownClaims(
          environmentId,
          yield* onMember(environmentId, { kind: "list" }),
        );
      }).pipe(
        Effect.catch((error) => Effect.logInfo("A mission member machine did not answer", error)),
      ),
    );

  // Set by whoever wants the machines' claims read again; a sweep without it only retries releases.
  const discoverNext = yield* Ref.make(false);
  const sweep = Effect.gen(function* () {
    const discover = yield* Ref.getAndSet(discoverNext, false);
    const asked = new Set([
      ...(yield* store.pendingReleases).map((release) => release.environmentId),
      ...(discover ? (yield* store.knownMachines).keys() : []),
    ]);
    yield* Effect.forEach(asked, (environmentId) => refreshMachine(environmentId, discover), {
      concurrency: "unbounded",
      discard: true,
    });
    // Links, reachability and lead threads change outside the store.
    yield* publish;
  }).pipe(
    Effect.withSpan("Missions.sweep"),
    Effect.catchCause((cause) => Effect.logError("Mission claims were not read again", cause)),
  );

  // One sweep at a time for the whole server. Requests made during a sweep share the next one.
  const sweepRequests = yield* Queue.sliding<void>(1);
  const retryReleases = Queue.offer(sweepRequests, undefined).pipe(Effect.asVoid);
  const refresh = Ref.set(discoverNext, true).pipe(Effect.andThen(retryReleases));
  yield* Queue.take(sweepRequests).pipe(
    Effect.andThen(sweep),
    Effect.forever,
    Effect.forkIn(background),
  );
  yield* Effect.sleep(REFRESH_INTERVAL).pipe(
    Effect.andThen(Effect.all([Ref.get(watchers), store.pendingReleases])),
    Effect.flatMap(([watching, pending]) =>
      watching > 0 ? refresh : pending.length > 0 ? retryReleases : Effect.void,
    ),
    Effect.forever,
    Effect.forkIn(background),
  );

  const missionNamed = Effect.fn("Missions.find")(function* (missionId: string) {
    const mission = (yield* store.missions).find((candidate) => candidate.missionId === missionId);
    return mission ?? (yield* fail("That mission was not found."));
  });

  const create = Effect.fn("Missions.create")(function* (input: {
    readonly missionId: string;
    readonly name: string;
    readonly leadThreadId: ThreadId;
  }) {
    const mission = yield* claims.create(here, input);
    return yield* missionView(mission, yield* machines, yield* store.pendingReleases);
  });

  const addMember = Effect.fn("Missions.addMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId, threadId } = input.member;
    yield* machineLocks
      .withLock(
        environmentId,
        Effect.gen(function* () {
          // Recorded before the call, so a machine whose answer is lost is still asked afterwards.
          if (environmentId !== here) {
            yield* linkTo(environmentId);
            yield* store.askMachine(environmentId);
          }
          // A release of this thread that still waits is finished first. The join then makes a new
          // claim, which that release cannot match if an earlier copy of it arrives late.
          for (const release of yield* store.pendingReleases) {
            if (memberKey(release) === memberKey(input.member)) yield* sendRelease(release);
          }
          const [claim] = yield* onMember(environmentId, {
            kind: "join",
            threadId,
            missionId: mission.missionId,
            name: mission.name,
          });
          if (claim === undefined)
            return yield* fail("The thread's machine answered with no claim.");
          if (environmentId !== here) yield* store.rememberClaim(environmentId, claim);
        }),
      )
      .pipe(
        Effect.catchTags({
          MissionMemberUnreachable: (error) =>
            refresh.pipe(
              Effect.andThen(
                fail(`${error.message} This machine checks again when ${error.label} answers.`),
              ),
            ),
        }),
      );
  });

  const releaseMember = Effect.fn("Missions.releaseMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId, threadId } = input.member;
    const claim = (yield* machines)
      .get(environmentId)
      ?.claims.find((held) => held.threadId === threadId && held.missionId === mission.missionId);
    if (claim === undefined) return yield* fail("That thread is not in this mission.");
    if (claim.role === "lead") {
      return yield* fail("A mission keeps its lead thread, so the lead cannot be released.");
    }
    const release = { ...input.member, missionId: mission.missionId, generation: claim.generation };
    yield* machineLocks.withLock(
      environmentId,
      sendRelease(release).pipe(
        Effect.catchTags({
          MissionMemberUnreachable: () =>
            store.addPendingRelease(release).pipe(Effect.andThen(retryReleases)),
        }),
      ),
    );
  });

  const watch = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so a change in between is not missed.
      const later = yield* PubSub.subscribe(views);
      const first = yield* Effect.acquireRelease(
        Ref.modify(watchers, (count) => [count === 0, count + 1]),
        () => Ref.update(watchers, (count) => count - 1),
      );
      if (first) yield* refresh;
      return Stream.concat(Stream.fromEffect(publish), Stream.fromSubscription(later)).pipe(
        Stream.changesWith(sameSnapshot),
      );
    }),
  );

  return Missions.of({ watch, create, addMember, releaseMember, leaveHere: claims.leaveHere });
});

export const layer = Layer.effect(Missions, make);

/** Mission tags mirror claims, so a client may not set or clear them by hand. */
export const refuseClientMissionTag = (command: OrchestrationV2Command) =>
  command.type === "thread.tag.set" && isMissionTag(command.tag)
    ? Effect.fail(
        new OrchestrationV2DispatchCommandError({
          commandId: command.commandId,
          commandType: command.type,
          message: "Mission tags change only through Missions.",
        }),
      )
    : Effect.void;
