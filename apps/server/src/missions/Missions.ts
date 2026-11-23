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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { MissionClaimResult } from "../mcp/toolkits/mission/tools.ts";
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

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const claims = yield* MissionClaims;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const background = yield* Effect.scope;
  // One call at a time per machine, so what is remembered of it follows the order of its answers.
  const machineLocks = yield* KeyedLock.make<EnvironmentId>();
  const linked = yield* Ref.make<ReadonlyMap<EnvironmentId, Machine>>(new Map());
  const watchers = yield* Ref.make(0);
  const changed = PubSub.publish(store.changes, undefined);

  // This machine's own claims are read each time, so only linked machines are remembered.
  const remember = (environmentId: EnvironmentId, update: (machine: Machine) => Machine) =>
    environmentId === here
      ? Effect.void
      : Ref.update(linked, (machines) =>
          new Map(machines).set(
            environmentId,
            update(machines.get(environmentId) ?? { claims: [], reachable: true }),
          ),
        ).pipe(Effect.andThen(changed));

  const machines = Effect.gen(function* () {
    const local: Machine = { claims: yield* store.claimsOf(here), reachable: true };
    return new Map([[here, local], ...(yield* Ref.get(linked))]);
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
  const assemble = Effect.gen(function* () {
    const held = yield* machines;
    const pending = yield* store.pendingReleases;
    return (mission: MissionRecord): Mission => {
      const lead = { environmentId: here, threadId: mission.leadThreadId };
      const members = new Map<string, MissionMember>([
        [memberKey(lead), { ref: lead, role: "lead", state: "active" }],
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
      // After a restart nothing is remembered of an offline machine, yet its release still waits.
      for (const { environmentId, threadId } of releasing) {
        const ref = { environmentId, threadId };
        if (!members.has(memberKey(ref))) {
          members.set(memberKey(ref), { ref, role: "member", state: "release-pending" });
        }
      }
      return {
        missionId: mission.missionId,
        name: mission.name,
        createdAt: mission.createdAt,
        members: [...members.values()],
      };
    };
  });

  const snapshot = Effect.all({
    missions: Effect.all([store.missions, assemble]).pipe(
      Effect.map(([missions, toMission]) => missions.map(toMission)),
    ),
    links: missionLinks,
    claims: Effect.map(store.allClaims, (held) =>
      held.map(({ threadId, missionId, name }) => ({ threadId, missionId, name })),
    ),
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
    const answered = yield* peers
      .call({
        environmentId,
        tool: "t3_mission_tag",
        arguments: { ...call },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: MissionClaimResult,
      })
      .pipe(
        Effect.timeoutOption(MEMBER_CALL_DEADLINE),
        // Transport and link failures say nothing about what happened there; refusals do.
        Effect.catch((error): Effect.Effect<never, MissionError | Unreachable> =>
          error.code === "orchestration_error"
            ? Effect.fail(new Unreachable({ label, message: error.message }))
            : fail(`${label} refused: ${error.message}`),
        ),
      );
    if (Option.isNone(answered)) {
      return yield* new Unreachable({ label, message: `${label} did not answer in time.` });
    }
    return answered.value.claims;
  });

  /** Call only under the machine's lock. An answer settles the release, whatever it found there. */
  const sendRelease = Effect.fn("Missions.sendRelease")(function* (release: PendingRelease) {
    yield* onMember(release.environmentId, { kind: "release", ...release });
    yield* store.clearPendingRelease(release);
    yield* remember(release.environmentId, (machine) => ({
      ...machine,
      claims: machine.claims.filter(
        (claim) => claim.threadId !== release.threadId || claim.generation !== release.generation,
      ),
    }));
  });

  const refreshMachine = (environmentId: EnvironmentId) =>
    machineLocks.withLock(
      environmentId,
      Effect.gen(function* () {
        for (const release of yield* store.pendingReleases) {
          if (release.environmentId === environmentId) yield* sendRelease(release);
        }
        const held = yield* onMember(environmentId, { kind: "list" });
        yield* remember(environmentId, () => ({ claims: held, reachable: true }));
      }).pipe(
        Effect.catch((error) =>
          Effect.logInfo("A mission member machine did not answer", error).pipe(
            Effect.andThen(
              remember(environmentId, (machine) => ({ ...machine, reachable: false })),
            ),
          ),
        ),
      ),
    );

  const sweep = Effect.gen(function* () {
    yield* claims.list(here);
    const asked =
      (yield* store.missions).length === 0
        ? []
        : [
            ...(yield* missionLinks)
              .filter((link) => link.fullAccess)
              .map((link) => link.environmentId),
            ...(yield* Ref.get(linked)).keys(),
            ...(yield* store.pendingReleases).map((release) => release.environmentId),
          ];
    yield* Effect.forEach(new Set(asked), refreshMachine, {
      concurrency: "unbounded",
      discard: true,
    });
    // Links change outside Missions; watchers read them again after every sweep.
    yield* changed;
  }).pipe(
    Effect.withSpan("Missions.sweep"),
    Effect.catchCause((cause) => Effect.logError("Mission claims were not read again", cause)),
  );

  // One sweep at a time for the whole server. Requests made during a sweep share the next one.
  const sweepRequests = yield* Queue.sliding<void>(1);
  const refresh = Queue.offer(sweepRequests, undefined).pipe(Effect.asVoid);
  yield* Queue.take(sweepRequests).pipe(
    Effect.andThen(sweep),
    Effect.forever,
    Effect.forkIn(background),
  );
  yield* Effect.sleep(REFRESH_INTERVAL).pipe(
    Effect.andThen(Effect.all([Ref.get(watchers), store.pendingReleases])),
    Effect.flatMap(([watching, pending]) =>
      watching > 0 || pending.length > 0 ? refresh : Effect.void,
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
    return (yield* assemble)(mission);
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
          const [claim] = yield* onMember(environmentId, {
            kind: "join",
            threadId,
            missionId: mission.missionId,
            name: mission.name,
          });
          if (claim === undefined)
            return yield* fail("The thread's machine answered with no claim.");
          // Adding again takes back a release of the same claim that still waits for this machine.
          yield* store.clearPendingRelease({
            environmentId,
            threadId,
            generation: claim.generation,
          });
          yield* remember(environmentId, (machine) => ({
            reachable: true,
            claims: [...machine.claims.filter((held) => held.threadId !== threadId), claim],
          }));
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
    yield* machineLocks.withLock(environmentId, sendRelease(release)).pipe(
      Effect.catchTags({
        MissionMemberUnreachable: () =>
          store.addPendingRelease(release).pipe(Effect.andThen(refresh)),
      }),
    );
  });

  const watch = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so a change in between is not missed.
      const changes = yield* PubSub.subscribe(store.changes);
      const first = yield* Effect.acquireRelease(
        Ref.modify(watchers, (count) => [count === 0, count + 1]),
        () => Ref.update(watchers, (count) => count - 1),
      );
      if (first) yield* refresh;
      return Stream.concat(
        Stream.fromEffect(snapshot),
        Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => snapshot)),
      ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));
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
