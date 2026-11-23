import {
  type EnvironmentId,
  isMissionTag,
  type Mission,
  MissionError,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  type MissionsSnapshot,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { MissionClaimResult } from "../mcp/toolkits/mission/tools.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { MissionClaims } from "./MissionClaims.ts";
import { type MissionClaim, MissionStore } from "./MissionStore.ts";

/** How long a lead waits on a member's machine before it treats the outcome as unknown. */
export const MEMBER_CALL_DEADLINE = Duration.seconds(10);
/** Links change outside Missions; the list is read again this often, so menu reasons follow. */
const LINKS_REREAD = Duration.seconds(15);

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
    /** Marks the member release-pending when its machine cannot be reached. */
    readonly releaseMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /**
     * The local user frees a thread on this machine from its Mission, whichever machine leads it.
     * The lead sees it as released on its next reconcile. The lead thread of a Mission here stays.
     */
    readonly leaveHere: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /** Brings this lead's records in line with the claims on these machines (all, by default). */
    readonly reconcile: (environmentIds?: ReadonlyArray<EnvironmentId>) => Effect.Effect<void>;
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
  | { readonly kind: "leave"; readonly threadId: ThreadId; readonly missionId: string }
  | { readonly kind: "undo"; readonly threadId: ThreadId; readonly claimId: string }
  | { readonly kind: "list" };

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const claims = yield* MissionClaims;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const background = yield* Effect.scope;
  // One change at a time. Each member call inside it is bounded by MEMBER_CALL_DEADLINE.
  const lock = yield* Semaphore.make(1);

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

  const claimsHere = Effect.map(store.allClaims, (claims) =>
    claims.map(({ threadId, missionId, name }) => ({ threadId, missionId, name })),
  );
  const snapshot = Effect.all({ missions: store.list, links: missionLinks, claims: claimsHere });

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
        case "leave":
          yield* claims.leave(here, call);
          return [];
        case "undo":
          yield* claims.undo(here, call);
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
    return answered.value.claims as ReadonlyArray<MissionClaim>;
  });

  const unknownOutcome = Effect.fn("Missions.unknownOutcome")(function* (
    environmentId: EnvironmentId,
    error: Unreachable,
  ): Effect.fn.Return<never, MissionError> {
    yield* Effect.forkIn(reconcile([environmentId]), background);
    return yield* fail(`${error.message} This machine checks again when ${error.label} answers.`);
  });

  /** Keeps a join only if the lead records it; otherwise takes back that one claim. */
  const recordOrUndo = Effect.fn("Missions.recordOrUndo")(function* (
    member: ScopedThreadRef,
    claim: MissionClaim,
    record: Effect.Effect<boolean>,
  ) {
    const recorded = yield* Effect.exit(record);
    if (Exit.isSuccess(recorded) && recorded.value) return;
    if (Exit.isFailure(recorded)) {
      yield* Effect.logError("A mission membership was not saved", recorded.cause);
    }
    yield* onMember(member.environmentId, {
      kind: "undo",
      threadId: member.threadId,
      claimId: claim.claimId,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("A claim was not taken back; reconcile adds or drops it", error),
      ),
    );
    return yield* fail(
      Exit.isSuccess(recorded)
        ? "This thread joined another mission meanwhile, so it was not added."
        : "This machine could not save the mission, so the thread was not added.",
    );
  });

  const missionNamed = Effect.fn("Missions.find")(function* (missionId: string) {
    const mission = (yield* store.list).find((candidate) => candidate.missionId === missionId);
    return mission ?? (yield* fail("That mission was not found."));
  });

  const refuseTakenElsewhere = Effect.fn("Missions.refuseTaken")(function* (
    ref: ScopedThreadRef,
    missionId: string,
  ) {
    const taken = yield* store.missionOf(ref);
    if (taken !== undefined && taken.missionId !== missionId) {
      return yield* fail(`This thread is already in the mission "${taken.name}".`);
    }
  });

  const create = Effect.fn("Missions.create")(function* (input: {
    readonly missionId: string;
    readonly name: string;
    readonly leadThreadId: ThreadId;
  }) {
    const lead = { environmentId: here, threadId: input.leadThreadId };
    yield* refuseTakenElsewhere(lead, input.missionId);
    const claim = yield* claims.join(here, { ...input, threadId: input.leadThreadId });
    yield* recordOrUndo(
      lead,
      claim,
      store.create({ missionId: input.missionId, name: input.name, lead }),
    );
    return yield* missionNamed(input.missionId);
  }, lock.withPermits(1));

  const addMember = Effect.fn("Missions.addMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    yield* refuseTakenElsewhere(input.member, mission.missionId);
    const [claim] = yield* onMember(input.member.environmentId, {
      kind: "join",
      threadId: input.member.threadId,
      missionId: mission.missionId,
      name: mission.name,
    }).pipe(
      Effect.catchTags({
        MissionMemberUnreachable: (error) => unknownOutcome(input.member.environmentId, error),
      }),
    );
    yield* recordOrUndo(input.member, claim!, store.addMember(mission.missionId, input.member));
  }, lock.withPermits(1));

  const releaseMember = Effect.fn("Missions.releaseMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const member = mission.members.find(
      (candidate) =>
        candidate.ref.environmentId === input.member.environmentId &&
        candidate.ref.threadId === input.member.threadId,
    );
    if (member === undefined || member.state === "released") {
      return yield* fail("That thread is not in this mission.");
    }
    if (member.role === "lead") {
      return yield* fail("A mission keeps its lead thread, so the lead cannot be released.");
    }
    yield* release(mission.missionId, input.member);
  }, lock.withPermits(1));

  const leaveHere = Effect.fn("Missions.leaveHere")(function* (threadId: ThreadId) {
    const leads = (yield* store.list).some((mission) =>
      mission.members.some(
        (member) =>
          member.role === "lead" &&
          member.ref.environmentId === here &&
          member.ref.threadId === threadId,
      ),
    );
    if (leads) {
      return yield* fail("A mission keeps its lead thread, so the lead cannot be released.");
    }
    const left = yield* claims.leaveHere(threadId);
    // A lead here catches up at once; a lead elsewhere on its next reconcile.
    if (left.owner === here) yield* Effect.forkIn(reconcile([here]), background);
  });

  /**
   * The member's machine drops its claim first; only then does the lead drop its record. If that
   * record is not dropped, the thread is free there while this lead still lists it, until the next
   * reconcile marks it released.
   */
  const release = Effect.fn("Missions.release")(function* (
    missionId: string,
    member: ScopedThreadRef,
  ): Effect.fn.Return<void, MissionError> {
    const left = yield* onMember(member.environmentId, {
      kind: "leave",
      threadId: member.threadId,
      missionId,
    }).pipe(
      Effect.as(true),
      Effect.catchTags({ MissionMemberUnreachable: () => Effect.succeed(false) }),
    );
    if (!left) return yield* store.setMemberState(missionId, member, "release-pending");
    yield* store
      .removeMember(missionId, member)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("A released member was not dropped here", cause).pipe(
            Effect.andThen(Effect.forkIn(reconcile([member.environmentId]), background)),
          ),
        ),
      );
  });

  /**
   * A claim with no active record gets one; an active record with no claim is marked released;
   * a pending release is finished. Machines that do not answer are left for the next time.
   */
  const reconcileMachine = Effect.fn("Missions.reconcileMachine")(
    function* (environmentId: EnvironmentId): Effect.fn.Return<void, MissionError | Unreachable> {
      const held = yield* onMember(environmentId, { kind: "list" });
      const missions = yield* store.list;
      for (const claim of held) {
        const ref = { environmentId, threadId: claim.threadId };
        const mission = missions.find((candidate) => candidate.missionId === claim.missionId);
        const record = mission?.members.find((member) => member.ref.threadId === claim.threadId);
        if (mission === undefined) {
          yield* onMember(environmentId, {
            kind: "undo",
            threadId: claim.threadId,
            claimId: claim.claimId,
          });
        } else if (record?.state === "release-pending") {
          yield* release(mission.missionId, ref);
        } else if (record?.state !== "active") {
          yield* store.addMember(mission.missionId, ref);
        }
      }
      for (const mission of missions) {
        for (const member of mission.members) {
          if (member.ref.environmentId !== environmentId || member.state === "released") continue;
          if (held.some((claim) => claim.threadId === member.ref.threadId)) continue;
          yield* member.state === "release-pending"
            ? store.removeMember(mission.missionId, member.ref)
            : store.setMemberState(mission.missionId, member.ref, "released");
        }
      }
    },
    Effect.catch((error) => Effect.logInfo("A mission member machine was not reconciled", error)),
  );

  const reconcile = Effect.fn("Missions.reconcile")(function* (
    environmentIds?: ReadonlyArray<EnvironmentId>,
  ): Effect.fn.Return<void> {
    const machines = environmentIds ?? [
      here,
      ...(yield* store.list).flatMap((mission) =>
        mission.members
          .filter((member) => member.state !== "released")
          .map((member) => member.ref.environmentId),
      ),
    ];
    for (const environmentId of new Set(machines)) {
      yield* lock.withPermits(1)(reconcileMachine(environmentId));
    }
  });

  const watch = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so a change in between is not missed.
      const changes = yield* PubSub.subscribe(store.changes);
      // A client asking for the list is a refresh: reconcile behind it.
      yield* Effect.forkIn(reconcile(), background);
      return Stream.concat(
        Stream.fromEffect(snapshot),
        Stream.merge(Stream.fromSubscription(changes), Stream.tick(LINKS_REREAD)).pipe(
          Stream.mapEffect(() => snapshot),
        ),
      ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));
    }),
  );

  return Missions.of({ watch, create, addMember, releaseMember, leaveHere, reconcile });
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
