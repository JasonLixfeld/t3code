import {
  type EnvironmentId,
  isMissionTag,
  linkOriginIsFenced,
  type Mission,
  MissionError,
  type MissionMember,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  missionNameFromTitle,
  type MissionsSnapshot,
  type ScopedThreadRef,
  threadHasMessages,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
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
import { assertTargetWithinLimits } from "../mcp/threadAccess.ts";
import type { DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MissionClaims, type ThreadAccess } from "./MissionClaims.ts";
import {
  type MemberDetail,
  markOf,
  memberDetail,
  memberStatusOf,
  missionPromptText,
  missionStatusText,
  type RosterMember,
  FOLLOW_UPS_PER_SWEEP,
  WORKSPACES_PER_CALL,
} from "./missionStatus.ts";
import { MemberWorkspaces } from "./MemberWorkspaces.ts";
import { MissionTurnContexts } from "./MissionTurnContexts.ts";
import {
  type MissionClaim,
  type MissionRecord,
  MissionStore,
  numberKey,
  type PendingAdd,
  type PendingRelease,
} from "./MissionStore.ts";
import { afterAnswer, afterMiss } from "./tombstoneChecks.ts";

/** How long a lead waits on a member's machine before it treats the outcome as unknown. */
export const MEMBER_CALL_DEADLINE = Duration.seconds(10);
/** How often a lead asks its linked machines again, while a client watches or a release waits. */
export const REFRESH_INTERVAL = Duration.seconds(15);
/** With no client watching and no remote member busy, members are asked this many intervals apart. */
export const IDLE_POLL_INTERVALS = 4;
/**
 * How long an add may wait for its machine before the lead stops sending it. Well inside the time
 * a member's machine remembers a spent add, so a lead restored from a backup cannot replay one.
 */
export const PENDING_ADD_DAYS = 7;
/** How many forks back a thread's history is followed to a lead it came from. */
export const FORK_WALK_HOPS = 64;
/** How soon a roster that shows an unfinished workspace may ask that member's machine again. */
const WORKSPACE_ASK_AGAIN_GAP = Duration.seconds(5);

export class Missions extends Context.Service<
  Missions,
  {
    /** The Missions here and the links that can reach member threads, now and after each change. */
    readonly watch: Stream.Stream<MissionsSnapshot>;
    /**
     * Starts a Mission led by a thread here, named for its title. Refuses a thread with no
     * messages. Asking again with the same id returns that Mission.
     */
    readonly create: (input: {
      readonly missionId: string;
      readonly leadThreadId: ThreadId;
    }) => Effect.Effect<Mission, MissionError>;
    /**
     * Makes a thread on this machine the Mission's lead, named for its title. A member of the
     * Mission becomes its lead; the other members stay. Refuses when the lead is no longer
     * `expectedLead`, and answers the Mission as it is when `lead` already leads it.
     */
    readonly setLead: (input: {
      readonly missionId: string;
      readonly lead: ScopedThreadRef;
      readonly expectedLead: ThreadId;
    }) => Effect.Effect<Mission, MissionError>;
    /** Ends a Mission that has no members. Its lead stays a thread, tagged as it was. */
    readonly deleteMission: (input: {
      readonly missionId: string;
    }) => Effect.Effect<void, MissionError>;
    /**
     * Leaves the add pending when the member's machine does not say what became of it. `asLead`:
     * a lead thread's agent asks, with that thread's reach, read again before every send.
     * Without it the user asks, with the user's.
     */
    readonly addMember: (
      input: {
        readonly missionId: string;
        readonly member: ScopedThreadRef;
        readonly noBrief?: true | undefined;
      },
      asLead?: ThreadId,
    ) => Effect.Effect<"joined" | "pending", MissionError>;
    /** A thread on another machine counts as having some: its lead cannot see its messages. */
    readonly hasPriorWork: (
      mission: Pick<MissionRecord, "leadThreadId">,
      member: ScopedThreadRef,
    ) => Effect.Effect<boolean>;
    /** Leaves the release pending when the member's machine cannot be reached. */
    readonly releaseMember: (
      input: { readonly missionId: string; readonly member: ScopedThreadRef },
      asLead?: ThreadId,
    ) => Effect.Effect<"released" | "pending", MissionError>;
    /** Stops waiting on a thread whose add or release its machine has not answered. Sends nothing. */
    readonly forgetMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /**
     * The local user frees a thread on this machine from its Mission, whichever machine leads it.
     * The lead thread of a Mission here stays. With `missionId`, only a thread still in that one.
     */
    readonly leaveHere: (
      threadId: ThreadId,
      missionId?: string,
    ) => Effect.Effect<void, MissionError>;
    /** The Mission a thread here leads, if it leads one. */
    readonly ledBy: (threadId: ThreadId) => Effect.Effect<MissionRecord | undefined>;
    /**
     * A lead's t3_thread_wait returned a member's run as completed, so the wake for that run would
     * tell it again. Drops that update unless a wake already took it.
     */
    readonly heardInWait: (
      lead: ThreadId,
      member: ScopedThreadRef,
      runId: string,
    ) => Effect.Effect<void>;
    /**
     * The Mission's members, without the lead, as this machine last knew them. Asks no other
     * machine: those on other machines are as the last sweep heard them.
     */
    readonly roster: (
      missionId: string,
    ) => Effect.Effect<ReadonlyArray<RosterMember>, MissionError>;
    /** The members and what each is doing, as a turn reads them: no names, and no new asks. */
    readonly memberStatuses: (
      missionId: string,
    ) => Effect.Effect<ReadonlyArray<RosterMember>, MissionError>;
    /** The members' numbers and places, for a wake to name them by. */
    readonly numbers: (
      missionId: string,
      members: ReadonlyArray<ScopedThreadRef>,
    ) => Effect.Effect<ReadonlyMap<string, { readonly member: string; readonly place: string }>>;
    readonly setPrompt: (input: {
      readonly missionId: string;
      readonly prompt: string;
    }) => Effect.Effect<void, MissionError>;
    /** Members on other machines whose detail a sweep heard change, or heard for the first time. */
    readonly remoteChanges: Stream.Stream<{
      readonly missionId: string;
      readonly ref: ScopedThreadRef;
      readonly detail: MemberDetail;
    }>;
    /**
     * A thread its lead started joins the lead's Mission, once: a replayed start that returns it
     * again, after a release say, does not. Undefined when it was started before.
     */
    readonly joinStarted: (
      input: { readonly missionId: string; readonly member: ScopedThreadRef },
      asLead: ThreadId,
    ) => Effect.Effect<"joined" | "pending" | undefined, MissionError>;
    /** Each Mission whose lead was replaced. */
    readonly leadChanges: Stream.Stream<string>;
    /** Missions a member just joined with prior work, whose lead has an update to hear. */
    readonly joinedWithPriorWork: Stream.Stream<string>;
    /**
     * Runs `use` with the Mission as it is now, under the lock its lead changes take, so the lead
     * it is given stays the lead until it is done. Undefined when the Mission is gone.
     */
    readonly withLead: <A, E, R>(
      missionId: string,
      use: (mission: MissionRecord) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | undefined, E, R>;
  }
>()("t3/missions/Missions") {}

/**
 * What one send may do, read when it is sent: the modes it goes out with, and the check a thread
 * here must pass, before its claim is written and again under its locks.
 */
interface Reach {
  readonly limits: DispatchModes;
  readonly mayChange?: ThreadAccess<MissionError>;
}

const denied = (message: string) => new MissionError({ message, reason: "denied" });

/** The user's own reach, which the lead machine's bookkeeping calls go out with. */
const USER_REACH: Reach = { limits: { runtimeMode: "full-access", interactionMode: "default" } };

/** The member's machine did not answer in time: the call may or may not have happened there. */
class Unreachable extends Schema.TaggedError<Unreachable>()("MissionMemberUnreachable", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

type ClaimCall =
  | {
      readonly kind: "join";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly name: string;
      readonly intentId: string;
      readonly announce?: boolean;
    }
  | {
      readonly kind: "release";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly generation: string;
    }
  | { readonly kind: "list" }
  | { readonly kind: "rename"; readonly missionId: string; readonly name: string }
  | {
      readonly kind: "workspaces";
      readonly members: ReadonlyArray<{ readonly threadId: ThreadId; readonly generation: string }>;
    };

/** The claims a machine holds for this lead, as it last said. */
interface Machine {
  readonly claims: ReadonlyArray<MissionClaim>;
  readonly reachable: boolean;
}

const memberKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
const sameSnapshot = (a: MissionsSnapshot, b: MissionsSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A snapshot with its place in the order they were read, so a watcher can drop an older one. */
interface Published {
  readonly version: number;
  readonly snapshot: MissionsSnapshot;
}

/** What this lead still waits to hear from other machines. */
interface Waiting {
  readonly releases: ReadonlyArray<PendingRelease>;
  readonly adds: ReadonlyArray<PendingAdd>;
}

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const claims = yield* MissionClaims;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const random = yield* SecureRandom.SecureRandom;
  const settings = yield* ServerSettings.ServerSettingsService;
  const turnContexts = yield* MissionTurnContexts;
  const readServices = yield* Effect.context<
    ThreadManagement.ThreadManagementService | Project.ProjectService | MemberWorkspaces
  >();
  const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const background = yield* Effect.scope;
  // One call at a time per machine, so what is remembered of it follows the order of its answers.
  const machineLocks = yield* KeyedLock.make<EnvironmentId>();
  // Empty after a restart: a machine counts as away until it answers again.
  const answering = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const watchers = yield* Ref.make(0);
  // The adds whose first join is on its way now. Their rows exist already, and are not shown as
  // pending until that call ends without an answer.
  const sending = yield* Ref.make<ReadonlySet<string>>(new Set());
  type RemoteDetail = {
    readonly missionId: string;
    readonly generation: string;
    readonly detail: MemberDetail;
  };
  /**
   * A machine that left a workspace out, or has not read it yet, keeps the one it last sent for
   * the same claim, marked stale.
   */
  const keptWorkspace = (
    detail: MemberDetail,
    last: RemoteDetail | undefined,
    generation: string,
  ): MemberDetail =>
    (detail.workspace === "omitted" || detail.workspace === "pending") &&
    last?.generation === generation &&
    typeof last.detail.workspace === "object"
      ? { ...detail, workspace: { ...last.detail.workspace, stale: true } }
      : detail;
  // What each member on another machine was doing when its machine last listed it, and the claim
  // it was listed under: its workspace is shown only while that claim holds.
  const remoteDetails = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, RemoteDetail>>
  >(new Map());
  const remoteChanged = yield* PubSub.unbounded<{
    readonly missionId: string;
    readonly ref: ScopedThreadRef;
    readonly detail: MemberDetail;
  }>();
  const leadChanged = yield* PubSub.unbounded<string>();
  const joined = yield* PubSub.unbounded<string>();
  // Held across a lead change, a delete, and the wake that names a Mission's lead.
  const missionLocks = yield* KeyedLock.make<string>();

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
    for (const [environmentId, known] of yield* store.knownClaims) {
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
  /** Deleted here, or never here. A thread that cannot be read is not taken for gone. */
  const threadGone = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell === null || shell.deletedAt !== null),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Lets go of member claims here whose threads are gone, as a delete does when its event is seen.
   * Run on start and on every sweep, so a delete missed while stopped is caught. A lead keeps its
   * claim, so its Mission can take a new lead.
   */
  const letGoOfGoneMembers = Effect.gen(function* () {
    for (const claim of yield* store.allClaims) {
      if (claim.role !== "member" || !(yield* threadGone(claim.threadId))) continue;
      yield* claims
        .leaveHere(claim.threadId)
        .pipe(Effect.catchTags({ MissionError: () => Effect.void }));
    }
  });

  const missionView = Effect.fn("Missions.view")(function* (
    mission: MissionRecord,
    held: ReadonlyMap<EnvironmentId, Machine>,
    waiting: Waiting,
  ) {
    const lead = { environmentId: here, threadId: mission.leadThreadId };
    // A lead thread that cannot be read is not taken for a deleted one. An archived lead is gone
    // from every list a client reads, so it shows as deleted too.
    const leadDeleted = yield* threads.getThreadShell(mission.leadThreadId).pipe(
      Effect.map(
        (shell) =>
          shell === null || shell.deletedAt !== null || (shell.archivedAt ?? null) !== null,
      ),
      Effect.orElseSucceed(() => false),
    );
    const members = new Map<string, MissionMember>([
      [memberKey(lead), { ref: lead, role: "lead", state: leadDeleted ? "deleted" : "active" }],
    ]);
    const releasing = waiting.releases.filter(
      (release) => release.missionId === mission.missionId && release.refusal === undefined,
    );
    const refusedReleases = waiting.releases.filter(
      (release) => release.missionId === mission.missionId && release.refusal !== undefined,
    );
    for (const [environmentId, machine] of held) {
      for (const claim of machine.claims) {
        if (claim.missionId !== mission.missionId || claim.role === "lead") continue;
        // A member deleted here is no longer one, whether or not its claim was let go yet.
        if (environmentId === here && (yield* threadGone(claim.threadId))) continue;
        const ref = { environmentId, threadId: claim.threadId };
        const sameClaim = (release: PendingRelease) =>
          memberKey(release) === memberKey(ref) && release.generation === claim.generation;
        const refusedRelease = refusedReleases.find(sameClaim);
        members.set(
          memberKey(ref),
          releasing.some(sameClaim)
            ? { ref, role: "member", state: "release-pending" }
            : refusedRelease !== undefined
              ? { ref, role: "member", state: "release-refused", detail: refusedRelease.refusal! }
              : { ref, role: "member", state: machine.reachable ? "active" : "offline" },
        );
      }
    }
    // A release can outlive the cached claim it was sent for. It still shows, so it can be forgotten.
    for (const { environmentId, threadId } of releasing) {
      const ref = { environmentId, threadId };
      if (!members.has(memberKey(ref))) {
        members.set(memberKey(ref), { ref, role: "member", state: "release-pending" });
      }
    }
    for (const add of waiting.adds) {
      if (add.missionId !== mission.missionId || members.has(memberKey(add))) continue;
      members.set(memberKey(add), {
        ref: { environmentId: add.environmentId, threadId: add.threadId },
        role: "member",
        ...(add.refusal === null
          ? { state: "add-pending" }
          : { state: "add-refused", detail: add.refusal }),
      });
    }
    return {
      missionId: mission.missionId,
      name: mission.name,
      createdAt: mission.createdAt,
      members: [...members.values()],
      ...(mission.prompt === "" ? {} : { prompt: mission.prompt }),
    } satisfies Mission;
  });

  const waiting = Effect.all({ releases: store.pendingReleases, adds: store.pendingAdds });
  const shown = Effect.gen(function* () {
    const { releases, adds } = yield* waiting;
    const underWay = yield* Ref.get(sending);
    return { releases, adds: adds.filter((add) => !underWay.has(add.intentId)) };
  });

  const snapshot = Effect.gen(function* () {
    const held = yield* machines;
    const owed = yield* shown;
    const views = yield* Effect.forEach(yield* store.missions, (mission) =>
      missionView(mission, held, owed),
    );
    // Each member gets its number when the view first shows it. A turn only reads them.
    for (const view of views) {
      yield* store.numbersOf(
        view.missionId,
        view.members.filter((member) => member.role === "member").map((member) => member.ref),
        here,
      );
    }
    return {
      missions: views,
      links: yield* missionLinks,
      claims: (yield* store.allClaims).map(({ threadId, missionId, name }) => ({
        threadId,
        missionId,
        name,
      })),
    } satisfies MissionsSnapshot;
  });

  // One fiber at a time reads and compares, so versions follow the order the snapshots were read.
  const publishing = yield* Semaphore.make(1);
  const published = yield* Ref.make<Published | undefined>(undefined);
  const views = yield* PubSub.unbounded<Published>();
  /** The snapshot now. Watchers hear of it only when it differs from the one before. */
  const publish = Effect.gen(function* () {
    const now = yield* snapshot;
    const last = yield* Ref.get(published);
    if (last !== undefined && sameSnapshot(last.snapshot, now)) return last;
    const next = { version: (last?.version ?? 0) + 1, snapshot: now };
    yield* Ref.set(published, next);
    yield* PubSub.publish(views, next);
    return next;
  }).pipe(publishing.withPermits(1));
  const storeChanged = PubSub.publish(store.changes, undefined);
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
    const { label, access, expiresAt } = link.value;
    if (access !== "full-access") {
      return yield* fail(
        `The link to ${label} has ${access} access. A link below full access may change only threads it started, so relink ${label} with full access to use its threads in a mission.`,
      );
    }
    if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
      return yield* fail(
        `The link to ${label} expired. Link it again with a new pairing code from ${label}.`,
      );
    }
    // Linking a machine again makes a new record, with a new session there.
    return { label, linkId: DateTime.formatIso(link.value.linkedAt) };
  });

  /**
   * Why a pending add may not be sent any more, if so. A link made again has a new session on
   * the thread's machine, where an add made under the old one no longer counts as spent by it.
   */
  const staleAdd = Effect.fn("Missions.staleAdd")(function* (add: PendingAdd) {
    const now = yield* DateTime.now;
    if (add.addedAt < DateTime.formatIso(DateTime.subtract(now, { days: PENDING_ADD_DAYS }))) {
      return `This add waited more than ${PENDING_ADD_DAYS} days for the thread's machine, so it was not sent again. Add the thread again.`;
    }
    const link = yield* linkTo(add.environmentId).pipe(Effect.orElseSucceed(() => undefined));
    return link === undefined || link.linkId === add.linkId
      ? undefined
      : `The link to ${link.label} was made again since this add, so it was not sent again. Add the thread again.`;
  });

  /**
   * Runs a claim call on the member's own machine. Only a refusal from that machine is a
   * MissionError. No answer in time, or a link this machine cannot use, is Unreachable: it says
   * nothing about the claims there.
   */
  const onMember = Effect.fn("Missions.onMember")(function* (
    environmentId: EnvironmentId,
    call: ClaimCall,
    reach: Reach = USER_REACH,
  ): Effect.fn.Return<
    ReadonlyArray<MissionClaim & { readonly detail?: MemberDetail | undefined }>,
    MissionError | Unreachable
  > {
    if (environmentId === here) {
      switch (call.kind) {
        case "join": {
          const joined = yield* claims.join(here, { ...call, ledHere: true }, reach.mayChange);
          return joined === "intent-spent" ? [] : [joined];
        }
        case "release":
          yield* claims.release(here, call, reach.mayChange);
          return [];
        case "list":
          return yield* claims.list(here);
        case "rename":
          return yield* claims.rename(here, call);
        // A member here is read where it is, never through a list.
        case "workspaces":
          return [];
      }
    }
    // A workspaces follow-up is optional detail: its answer, or its silence, says nothing of
    // whether the machine answers.
    const settlesReach = call.kind !== "workspaces";
    const { label } = yield* linkTo(environmentId).pipe(
      Effect.catch((error) =>
        (settlesReach ? setAnswering(environmentId, false) : Effect.void).pipe(
          Effect.andThen(Effect.fail(new Unreachable({ message: error.message }))),
        ),
      ),
    );
    const answered = yield* peers
      .call({
        environmentId,
        tool: "t3_mission_tag",
        arguments: { ...call },
        limits: reach.limits,
        success: MissionClaimResult,
      })
      .pipe(Effect.timeoutOption(MEMBER_CALL_DEADLINE), Effect.result);
    // Transport failures, and a peer that no longer accepts the link, say nothing about what
    // happened there. A refusal from the tool does.
    const unreachable = Result.isFailure(answered)
      ? answered.failure.code === "orchestration_error" ||
        answered.failure.message === PeerMcpClient.LINK_NOT_ACCEPTED
        ? answered.failure.message
        : undefined
      : Option.isNone(answered.success)
        ? `${label} did not answer in time.`
        : undefined;
    if (settlesReach) yield* setAnswering(environmentId, unreachable === undefined);
    if (unreachable !== undefined) return yield* new Unreachable({ message: unreachable });
    if (Result.isFailure(answered)) {
      return yield* fail(`${label} refused: ${answered.failure.message}`);
    }
    return Option.getOrThrow(answered.success).claims;
  });

  /** Call only under the machine's lock. An answer settles the release, whatever it found there. */
  const sendRelease = Effect.fn("Missions.sendRelease")(function* (
    release: PendingRelease,
    reach: Reach,
  ) {
    yield* onMember(
      release.environmentId,
      {
        kind: "release",
        threadId: release.threadId,
        missionId: release.missionId,
        generation: release.generation,
      },
      reach,
    );
    yield* store.clearPendingRelease(release);
    yield* store.forgetClaim(release);
  });

  const hasPriorWork = Effect.fn("Missions.hasPriorWork")(function* (
    mission: Pick<MissionRecord, "leadThreadId">,
    member: ScopedThreadRef,
  ) {
    if (member.environmentId !== here) return true;
    if (member.threadId === mission.leadThreadId) return false;
    const shell = yield* threads
      .getThreadShell(member.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    return shell !== null && shell.deletedAt === null && shell.latestUserMessageAt !== null;
  });

  /**
   * Call only under the machine's lock. Any answer settles the add: the claim it made, or no
   * claim when the thread has left since, which spends the add there. A join is safe to send
   * again, because every copy names the same add and gets the one claim that add made.
   */
  const sendJoin = Effect.fn("Missions.sendJoin")(function* (
    mission: MissionRecord,
    add: Omit<PendingAdd, "refusal">,
    reach: Reach,
  ) {
    // Read again under the machine's lock: a rename since the add began must not be lost.
    const { name } = yield* missionNamed(mission.missionId);
    // The lead hears of a new claim with the write that makes it: here or when it settles.
    const announce = add.noBrief !== true && (yield* hasPriorWork(mission, add));
    const [claim] = yield* onMember(
      add.environmentId,
      {
        kind: "join",
        threadId: add.threadId,
        missionId: mission.missionId,
        name,
        intentId: add.intentId,
        ...(add.environmentId === here && announce ? { announce } : {}),
      },
      reach,
    );
    // This machine's own threads have no pending row, and their claims are read, not remembered.
    if (add.environmentId !== here) {
      yield* claim === undefined
        ? store.clearPendingAdd(add)
        : store.settleAdd(add, claim, announce);
    }
    if (claim !== undefined && announce) yield* PubSub.publish(joined, mission.missionId);
    // None: the claim this add made was dropped there since, so the thread stays out.
    return claim !== undefined;
  });

  /**
   * What a write asked by `asLead` may do now, read from the Mission and its lead thread as they
   * are, never kept from when it was asked: that thread must still lead the Mission, and its
   * modes and its link's fence are its own now. Run under the Mission's lock, which a lead change
   * takes, so the lead it reads stays the lead until the write is done.
   */
  const reachOf = Effect.fn("Missions.reachOf")(function* (
    missionId: string,
    asLead: ThreadId | undefined,
    target: ScopedThreadRef,
  ) {
    if (asLead === undefined) return USER_REACH;
    const mission = (yield* store.missions).find((candidate) => candidate.missionId === missionId);
    if (mission?.leadThreadId !== asLead) {
      return yield* denied(
        `Thread ${asLead} no longer leads this mission, so the change it asked for was not made.`,
      );
    }
    const lead = yield* threads.getThreadShell(asLead).pipe(Effect.orElseSucceed(() => null));
    if (lead === null || lead.deletedAt !== null || lead.archivedAt !== null) {
      return yield* denied(
        "This mission's lead thread is gone, so the change it asked for was not made.",
      );
    }
    const limits = { runtimeMode: lead.runtimeMode, interactionMode: lead.interactionMode };
    // As every T3 tool: work a link below full access started may change only that link's
    // threads, and may not reach other machines through this one, whose session the peer sees.
    const fence =
      lead.linkOrigin !== undefined && linkOriginIsFenced(lead.linkOrigin)
        ? lead.linkOrigin
        : undefined;
    if (target.environmentId !== here) {
      if (fence !== undefined) {
        return yield* denied(
          `This lead was started from ${fence.label} through a linked environment, so it cannot use this environment's links. A link paired with full access is not limited this way.`,
        );
      }
      return { limits } satisfies Reach;
    }
    const mayChange: ThreadAccess<MissionError> = (thread) =>
      assertTargetWithinLimits(limits, thread).pipe(
        Effect.mapError((failure) => denied(failure.message)),
        Effect.andThen(
          fence !== undefined && thread.linkOrigin?.sessionId !== fence.sessionId
            ? Effect.fail(
                denied(
                  `This lead was started from ${fence.label} through a linked environment, so it may change only threads that link started.`,
                ),
              )
            : Effect.void,
        ),
      );
    return { limits, mayChange } satisfies Reach;
  });

  /** A thread here passes the write's check before its claim is written, and again under its locks. */
  const checkHere = Effect.fn("Missions.checkHere")(function* (
    target: ScopedThreadRef,
    reach: Reach,
  ) {
    if (target.environmentId !== here || reach.mayChange === undefined) return;
    const shell = yield* threads
      .getThreadShell(target.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell !== null && shell.deletedAt === null) yield* reach.mayChange(shell);
  });

  /**
   * One pending write, with the reach of whoever asked for it, read now under its Mission's
   * lock. A refusal marks only it. Never call it holding a Mission's lock: no code holds two.
   */
  const sendPending = <A>(
    row: { readonly missionId: string; readonly actor?: ThreadId | undefined } & ScopedThreadRef,
    send: (reach: Reach) => Effect.Effect<A, MissionError | Unreachable>,
    refuse: (refusal: string) => Effect.Effect<void>,
  ) =>
    missionLocks
      .withLock(row.missionId, Effect.flatMap(reachOf(row.missionId, row.actor, row), send))
      .pipe(Effect.asVoid, Effect.catchTags({ MissionError: (error) => refuse(error.message) }));

  const refreshMachine = (environmentId: EnvironmentId) =>
    machineLocks.withLock(
      environmentId,
      Effect.gen(function* () {
        // Each row stands alone: a refusal marks that row and the next goes. Only a machine
        // that does not answer ends the sweep of it.
        for (const release of yield* store.pendingReleases) {
          if (release.environmentId !== environmentId || release.refusal !== undefined) continue;
          yield* sendPending(
            release,
            (reach) => sendRelease(release, reach),
            (refusal) => store.refusePendingRelease(release, refusal),
          );
        }
        const missions = yield* store.missions;
        for (const add of yield* store.pendingAdds) {
          const mission = missions.find((candidate) => candidate.missionId === add.missionId);
          if (add.environmentId !== environmentId || add.refusal !== null) continue;
          if (mission === undefined) yield* store.clearPendingAdd(add);
          else {
            const stale = yield* staleAdd(add);
            if (stale !== undefined) {
              yield* store.setPendingAdd({ ...add, refusal: stale });
              continue;
            }
            yield* sendPending(
              add,
              (reach) => sendJoin(mission, add, reach),
              (refusal) => store.setPendingAdd({ ...add, refusal }),
            );
          }
        }
        const check = (yield* store.tombstoneChecks).find(
          (candidate) => candidate.environmentId === environmentId,
        );
        const askedAt = DateTime.toEpochMillis(yield* DateTime.now);
        // Every sweep of a machine that answers lists it, since its list is what wakes a lead.
        let held = yield* onMember(environmentId, { kind: "list" }).pipe(
          Effect.tapError(() =>
            check === undefined
              ? Effect.void
              : store.setTombstoneCheck(environmentId, afterMiss(check, askedAt)),
          ),
        );
        // A claim on a Mission deleted here may have landed after the delete, from an add whose
        // answer never came. Any list, for whatever reason it was asked, releases each as any
        // member is released. A claim made under an old link owner, before a re-pair, is not
        // listed here; Leave mission on that machine frees it.
        const deleted = yield* store.deletedMissionIds;
        for (const claim of held) {
          if (!deleted.has(claim.missionId)) continue;
          // The lead machine's own upkeep of a Mission no one leads now: the user's reach.
          yield* sendRelease({ environmentId, ...claim }, USER_REACH).pipe(
            Effect.catchTags({
              MissionError: (error) => Effect.logInfo("A deleted mission's claim stayed", error),
            }),
          );
        }
        held = held.filter((claim) => !deleted.has(claim.missionId));
        // A refused release whose claim is gone from the list has nothing left to release.
        for (const release of yield* store.pendingReleases) {
          if (
            release.environmentId === environmentId &&
            release.refusal !== undefined &&
            !held.some(
              (claim) =>
                claim.threadId === release.threadId &&
                claim.missionId === release.missionId &&
                claim.generation === release.generation,
            )
          ) {
            yield* store.clearPendingRelease(release);
          }
        }
        yield* noteRemoteDetails(environmentId, held);
        // A rename below answers claims without their detail.
        const listed = held;
        if (check !== undefined) {
          yield* store.setTombstoneCheck(environmentId, afterAnswer(check, askedAt));
        }
        // A member's claim, and so its tag, carries the Mission's name. A lead renamed since is
        // sent to the member's machine here, as often as it still answers with the old name.
        for (const mission of missions) {
          if (
            held.some(
              (claim) => claim.missionId === mission.missionId && claim.name !== mission.name,
            )
          ) {
            const before = held;
            // A machine that refuses, as one without renames does, keeps the old name.
            held = yield* onMember(environmentId, {
              kind: "rename",
              missionId: mission.missionId,
              name: mission.name,
            }).pipe(Effect.catchTags({ MissionError: () => Effect.succeed(before) }));
          }
        }
        yield* store.setKnownClaims(environmentId, held);
        // Only once the list is kept: a slow or failed follow-up must not undo it.
        yield* fetchOmittedWorkspaces(environmentId, listed);
      }).pipe(
        Effect.catch((error) => Effect.logInfo("A mission member machine did not answer", error)),
      ),
    );

  /**
   * Remembers what a listing machine said its members are doing, in one step for that machine,
   * then tells who listens of each member whose detail changed.
   */
  const noteRemoteDetails = Effect.fn("Missions.noteRemoteDetails")(function* (
    environmentId: EnvironmentId,
    listed: ReadonlyArray<MissionClaim & { readonly detail?: MemberDetail | undefined }>,
  ) {
    const changed = yield* Ref.modify(remoteDetails, (before) => {
      const seen = before.get(environmentId);
      const next = new Map(before);
      next.set(
        environmentId,
        new Map(
          listed.flatMap(({ threadId, missionId, generation, detail }) =>
            detail === undefined
              ? []
              : [
                  [
                    threadId,
                    {
                      missionId,
                      generation,
                      detail: keptWorkspace(detail, seen?.get(threadId), generation),
                    },
                  ] as const,
                ],
          ),
        ),
      );
      const news = listed.filter((claim) => {
        const last = seen?.get(claim.threadId)?.detail;
        return (
          claim.detail !== undefined &&
          (last === undefined || markOf(last) !== markOf(claim.detail))
        );
      });
      return [news, next] as const;
    });
    for (const claim of changed) {
      yield* PubSub.publish(remoteChanged, {
        missionId: claim.missionId,
        ref: { environmentId, threadId: claim.threadId },
        detail: claim.detail!,
      });
    }
  });

  // When each workspace still omitted was last asked for, by machine, then thread and claim.
  const lastFetched = new Map<EnvironmentId, Map<string, number>>();
  /**
   * Workspaces a list left out for room, asked for a few at a time, under the same claims, until
   * each has come or is too large to, or this sweep's follow-ups to the machine are spent.
   */
  const fetchOmittedWorkspaces = Effect.fn("Missions.fetchOmittedWorkspaces")(function* (
    environmentId: EnvironmentId,
    listed: ReadonlyArray<MissionClaim & { readonly detail?: MemberDetail | undefined }>,
  ) {
    const keyOf = (member: { readonly threadId: ThreadId; readonly generation: string }) =>
      JSON.stringify([member.threadId, member.generation]);
    const omitted = listed.flatMap(({ threadId, generation, detail }) =>
      detail?.workspace === "omitted" ? [{ threadId, generation }] : [],
    );
    const earlier = lastFetched.get(environmentId);
    const fetched = new Map(
      omitted.flatMap((member) => {
        const at = earlier?.get(keyOf(member));
        return at === undefined ? [] : [[keyOf(member), at] as const];
      }),
    );
    lastFetched.set(environmentId, fetched);
    // The least recently fetched go first, so the members a sweep did not reach go first next.
    let left = omitted.toSorted(
      (a, b) => (fetched.get(keyOf(a)) ?? 0) - (fetched.get(keyOf(b)) ?? 0),
    );
    for (let call = 0; call < FOLLOW_UPS_PER_SWEEP && left.length > 0; call += 1) {
      const batch = left.slice(0, WORKSPACES_PER_CALL);
      const answered = yield* onMember(environmentId, { kind: "workspaces", members: batch }).pipe(
        // A machine that predates the call refuses it, and its workspaces stay as they were. One
        // that does not answer in time is asked on the next sweep.
        Effect.catchTags({
          MissionError: () => Effect.undefined,
          MissionMemberUnreachable: () => Effect.undefined,
        }),
      );
      if (answered === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      for (const member of batch) fetched.set(keyOf(member), now);
      yield* Ref.update(remoteDetails, (before) => {
        const known = new Map(before.get(environmentId));
        for (const { threadId, generation, detail } of answered) {
          const last = known.get(threadId);
          if (last?.generation !== generation || detail?.workspace === undefined) continue;
          known.set(threadId, {
            ...last,
            detail: keptWorkspace(
              { ...last.detail, workspace: detail.workspace },
              last,
              generation,
            ),
          });
        }
        return new Map(before).set(environmentId, known);
      });
      const stillOmitted = new Set(
        answered.flatMap((claim) => (claim.detail?.workspace === "omitted" ? [keyOf(claim)] : [])),
      );
      // Every answer carries at least one workspace, so each round settles one or more.
      if (stillOmitted.size === batch.length) return;
      left = [
        ...left.slice(batch.length),
        ...batch.filter((member) => stillOmitted.has(keyOf(member))),
      ];
    }
  });

  /** The machines that owe an answer to an add or a release. They stay in every sweep. */
  const owingAnAnswer = Effect.map(
    Effect.all([waiting, store.tombstoneChecks, DateTime.now]),
    ([{ releases, adds }, checks, now]) => [
      ...[
        ...releases.filter((release) => release.refusal === undefined),
        ...adds.filter((add) => add.refusal === null),
      ].map((owed) => owed.environmentId),
      // A deleted Mission's machines that are due to be asked again.
      ...checks
        .filter((check) => check.nextAt <= DateTime.toEpochMillis(now))
        .map((check) => check.environmentId),
    ],
  );
  // Set by whoever wants the machines' claims read again; a sweep without it only sends again
  // what still waits for an answer.
  const discoverNext = yield* Ref.make(false);
  // Machines a roster asked to be read again, each once, in the next sweep.
  const machinesAsked = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  /**
   * Each Mission takes its lead thread's title as its name. The claims here are checked against
   * it every time, so a stop between the two writes heals on the next sweep.
   */
  const followLeadTitles = Effect.gen(function* () {
    for (const mission of yield* store.missions) {
      const shell = yield* threads
        .getThreadShell(mission.leadThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      const name =
        shell === null || shell.deletedAt !== null
          ? mission.name
          : missionNameFromTitle(shell.title);
      // A new lead may have taken over since the title was read, and its title wins.
      const named =
        name === mission.name
          ? name
          : yield* store.renameMission({
              missionId: mission.missionId,
              lead: mission.leadThreadId,
              name,
            });
      yield* claims.rename(here, { missionId: mission.missionId, name: named });
    }
  });

  const sweep = Effect.gen(function* () {
    yield* letGoOfGoneMembers;
    yield* followLeadTitles;
    const discover = yield* Ref.getAndSet(discoverNext, false);
    const asked = new Set([
      ...(yield* owingAnAnswer),
      ...(yield* Ref.getAndSet(machinesAsked, new Set())),
      ...(discover ? (yield* store.knownClaims).keys() : []),
    ]);
    yield* Effect.forEach(asked, refreshMachine, {
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
  const retryWaiting = Queue.offer(sweepRequests, undefined).pipe(Effect.asVoid);
  const refresh = Ref.set(discoverNext, true).pipe(Effect.andThen(retryWaiting));
  // Deletes missed while this server was stopped.
  yield* letGoOfGoneMembers.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Deleted members were not let go", cause)),
    Effect.forkIn(background),
  );
  yield* Queue.take(sweepRequests).pipe(
    Effect.andThen(sweep),
    Effect.forever,
    Effect.forkIn(background),
  );
  // Members on other machines are asked with no one watching too, so their lead hears when one
  // needs it: each interval while one is busy, and every IDLE_POLL_INTERVALS intervals otherwise.
  const idleTicks = yield* Ref.make(0);
  yield* Effect.sleep(REFRESH_INTERVAL).pipe(
    Effect.andThen(Effect.all([Ref.get(watchers), owingAnAnswer, store.knownClaims])),
    Effect.flatMap(([watching, owing, known]) =>
      Effect.gen(function* () {
        const busy = [...(yield* Ref.get(remoteDetails)).values()].some((machine) =>
          [...machine.values()].some(
            ({ detail }) => detail.status !== "idle" && detail.status !== "failed",
          ),
        );
        const ticks = yield* Ref.updateAndGet(idleTicks, (count) => count + 1);
        if (watching > 0 || busy || (known.size > 0 && ticks % IDLE_POLL_INTERVALS === 0)) {
          return yield* refresh;
        }
        if (owing.length > 0) yield* retryWaiting;
      }),
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
    readonly leadThreadId: ThreadId;
  }) {
    const shell = yield* threads
      .getThreadShell(input.leadThreadId)
      .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));
    if (shell !== null && shell.deletedAt === null && !threadHasMessages(shell)) {
      return yield* fail("A mission needs a lead thread with messages. Send a message first.");
    }
    const mission = yield* claims.create(here, {
      ...input,
      name: missionNameFromTitle(shell?.title ?? ""),
    });
    return yield* missionView(mission, yield* machines, yield* shown);
  });

  const deleteMission = Effect.fn("Missions.deleteMission")(function* (input: {
    readonly missionId: string;
  }) {
    const mission = yield* missionNamed(input.missionId);
    // A member whose thread is gone holds nothing back. Claims elsewhere that the lead cannot
    // see, from adds never answered, are released by the sweeps the tombstone keeps asking.
    yield* letGoOfGoneMembers;
    // Every machine this one can add from is asked too: an older build kept no list of the
    // machines a Mission sent to, and an add forgotten there left nothing behind.
    const machines = (yield* missionLinks)
      .filter((link) => link.fullAccess)
      .map((link) => link.environmentId);
    yield* missionLocks.withLock(
      mission.missionId,
      claims.deleteMission({ missionId: mission.missionId, lead: mission.leadThreadId, machines }),
    );
  });

  const setLead = Effect.fn("Missions.setLead")(function* (input: {
    readonly missionId: string;
    readonly lead: ScopedThreadRef;
    readonly expectedLead: ThreadId;
  }) {
    const mission = yield* missionNamed(input.missionId);
    if (input.lead.environmentId !== here) {
      return yield* fail(
        "A mission lives on its lead's machine, so its new lead must be a thread on that machine.",
      );
    }
    const shell = yield* threads
      .getThreadShell(input.lead.threadId)
      .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));
    // The write takes the lock a wake holds, so no wake is sent to a lead replaced meanwhile.
    const record = yield* missionLocks.withLock(
      mission.missionId,
      claims.setLead(here, {
        missionId: mission.missionId,
        name: missionNameFromTitle(shell?.title ?? ""),
        leadThreadId: input.lead.threadId,
        previous: input.expectedLead,
      }),
    );
    // Updates belong to the Mission, so its new lead hears what its old one had not.
    if (record.leadThreadId !== input.expectedLead) {
      yield* PubSub.publish(leadChanged, record.missionId);
    }
    return yield* missionView(record, yield* machines, yield* shown);
  });

  /** `intentId`: the add a replayed start made, so a machine that spent it refuses it. */
  const addWithIntent = Effect.fn("Missions.addWithIntent")(function* (
    input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
      readonly noBrief?: true | undefined;
    },
    asLead: ThreadId | undefined,
    intentId: string,
  ) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId } = input.member;
    const setSending = (isSending: boolean) =>
      Ref.update(sending, (current) => {
        const next = new Set(current);
        if (isSending) next.add(intentId);
        else next.delete(intentId);
        return next;
      });
    yield* setSending(true);
    // A release of this thread that still waits is finished first, under its own Mission's lock
    // and with the reach of whoever asked for it, before this add takes its Mission's lock: no
    // code holds two Mission locks, so two adds that cross cannot wait on each other. The join
    // then makes a new claim, which that release cannot match if an earlier copy arrives.
    const releaseWaiting = Effect.gen(function* () {
      let answered = true;
      for (const release of yield* store.pendingReleases) {
        if (memberKey(release) !== memberKey(input.member) || release.refusal !== undefined) {
          continue;
        }
        yield* sendPending(
          release,
          (reach) => sendRelease(release, reach),
          (refusal) => store.refusePendingRelease(release, refusal),
        ).pipe(
          Effect.catchTags({
            MissionMemberUnreachable: () => Effect.sync(() => (answered = false)),
          }),
        );
      }
      return answered;
    });
    return yield* machineLocks
      .withLock(
        environmentId,
        Effect.flatMap(releaseWaiting, (released) =>
          missionLocks.withLock(
            mission.missionId,
            Effect.gen(function* () {
              // Read under the Mission's lock, right before anything is written or sent.
              const reach = yield* reachOf(mission.missionId, asLead, input.member);
              yield* checkHere(input.member, reach);
              // A link this machine cannot use refuses the add here, before anything is written.
              const linkId = environmentId === here ? "" : (yield* linkTo(environmentId)).linkId;
              const add = {
                ...input.member,
                missionId: mission.missionId,
                intentId,
                linkId,
                addedAt: DateTime.formatIso(yield* DateTime.now),
                refusal: null,
                ...(asLead === undefined ? {} : { actor: asLead }),
                ...(input.noBrief === true ? { noBrief: true as const } : {}),
              };
              return yield* Effect.gen(function* () {
                // Written before anything is sent. If this call is cut off, or the server stops,
                // the add is still there to send again. This machine's own threads need none.
                if (environmentId !== here) yield* store.setPendingAdd(add);
                // A release its machine did not answer may yet land: the join waits with it.
                if (!released) {
                  return yield* new Unreachable({
                    message: "The thread's machine did not answer.",
                  });
                }
                return (yield* sendJoin(mission, add, reach))
                  ? ("joined" as const)
                  : ("spent" as const);
              }).pipe(
                Effect.catchTags({
                  // Nobody knows whether the join landed. The add stays, and is sent again, until
                  // the thread's machine says what became of it.
                  MissionMemberUnreachable: () => Effect.as(refresh, "pending" as const),
                  MissionError: (error) =>
                    store.clearPendingAdd(add).pipe(Effect.andThen(Effect.fail(error))),
                }),
              );
            }),
          ),
        ),
      )
      .pipe(Effect.ensuring(setSending(false).pipe(Effect.andThen(storeChanged))));
  });

  const addMember = Effect.fn("Missions.addMember")(function* (
    input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
      readonly noBrief?: true | undefined;
    },
    asLead?: ThreadId,
  ) {
    const added = yield* addWithIntent(input, asLead, yield* random.uuidV4().pipe(Effect.orDie));
    // A new intent was never spent, so only a replayed start meets that answer.
    return added === "spent" ? yield* fail("That thread left this mission.") : added;
  });

  const releaseMember = Effect.fn("Missions.releaseMember")(function* (
    input: { readonly missionId: string; readonly member: ScopedThreadRef },
    asLead?: ThreadId,
  ) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId, threadId } = input.member;
    return yield* machineLocks.withLock(
      environmentId,
      missionLocks.withLock(
        mission.missionId,
        Effect.gen(function* () {
          // Who asks, and whether it may, first; then whether the thread is this Mission's.
          // Nothing changes until both hold.
          const reach = yield* reachOf(mission.missionId, asLead, input.member);
          yield* checkHere(input.member, reach);
          const refused = (yield* store.pendingAdds).find(
            (add) =>
              memberKey(add) === memberKey(input.member) &&
              add.missionId === mission.missionId &&
              add.refusal !== null,
          );
          const claim = (yield* machines)
            .get(environmentId)
            ?.claims.find(
              (held) => held.threadId === threadId && held.missionId === mission.missionId,
            );
          if (claim === undefined && refused === undefined) {
            return yield* fail("That thread is not in this mission.");
          }
          if (claim?.role === "lead") {
            return yield* fail("A mission keeps its lead thread, so the lead cannot leave.");
          }
          // A refusal the view hides behind a live claim must not take the release meant for it.
          if (refused !== undefined) yield* store.clearPendingAdd(refused);
          // A thread a lead started stays out once released, whatever replays its start.
          yield* store.startedReleased({ ...input.member, missionId: mission.missionId });
          // The thread never joined, so releasing it only puts the refusal away.
          if (claim === undefined) return "released" as const;
          const release = {
            ...input.member,
            missionId: mission.missionId,
            generation: claim.generation,
            ...(asLead === undefined ? {} : { actor: asLead }),
          };
          return yield* sendRelease(release, reach).pipe(
            Effect.as("released" as const),
            Effect.catchTags({
              MissionMemberUnreachable: () =>
                store
                  .addPendingRelease(release)
                  .pipe(Effect.andThen(retryWaiting), Effect.as("pending" as const)),
            }),
          );
        }),
      ),
    );
  });

  const forgetMember = Effect.fn("Missions.forgetMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    yield* machineLocks.withLock(
      input.member.environmentId,
      Effect.gen(function* () {
        const { releases, adds } = yield* waiting;
        const waits = [
          ...releases.filter((release) => release.refusal === undefined),
          ...adds.filter((add) => add.refusal === null),
        ].some(
          (owed) =>
            memberKey(owed) === memberKey(input.member) && owed.missionId === mission.missionId,
        );
        const refusedRelease = releases.find(
          (release) =>
            memberKey(release) === memberKey(input.member) &&
            release.missionId === mission.missionId &&
            release.refusal !== undefined,
        );
        // Dismissing a refused release puts only it away: the thread stays in the Mission.
        if (!waits && refusedRelease !== undefined) {
          return yield* store
            .clearPendingRelease(refusedRelease)
            .pipe(Effect.andThen(storeChanged));
        }
        if (!waits) return yield* fail("This thread is not waiting on its machine.");
        // Nothing is sent, and only this Mission's rows for the thread go. A claim the machine
        // still holds, or a join that lands there later, is real: it shows again whenever that
        // machine is swept, and Leave mission there frees the thread.
        yield* store.forgetThread({ ...input.member, missionId: mission.missionId });
      }),
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
      // Read under the same lock as every published snapshot, so what was published before it
      // is older and is dropped.
      const current = yield* publish;
      return Stream.concat(
        Stream.succeed(current.snapshot),
        Stream.fromSubscription(later).pipe(
          Stream.filter((next) => next.version > current.version),
          Stream.map((next) => next.snapshot),
        ),
      );
    }),
  );

  const ledBy = (threadId: ThreadId) =>
    Effect.map(store.missions, (missions) =>
      missions.find((mission) => mission.leadThreadId === threadId),
    );

  const machineLabels = Effect.map(
    missionLinks,
    (named) => new Map(named.map((link) => [link.environmentId, link.label])),
  );

  /**
   * Each member's number, as "member 3", and its place, "this machine" or "machine 2". Only
   * read: one the view has not numbered yet is "a member" on "another machine".
   */
  const numbers = Effect.fn("Missions.numbers")(function* (
    missionId: string,
    members: ReadonlyArray<ScopedThreadRef>,
  ) {
    const given = yield* store.numbersKnown(missionId);
    return new Map(
      members.map((ref) => {
        const member = given.member.get(numberKey(ref));
        const machine = given.machine.get(ref.environmentId);
        return [
          numberKey(ref),
          {
            member: member === undefined ? "a member" : `member ${member}`,
            place:
              ref.environmentId === here
                ? "this machine"
                : machine === undefined
                  ? "another machine"
                  : `machine ${machine}`,
          },
        ];
      }),
    );
  });

  // When each machine was last asked again for a workspace a roster showed unfinished.
  const askedAgain = new Map<EnvironmentId, number>();
  /** Asks each machine again in the background, at most once per gap, so a second look finds it. */
  const askAgainSoon = Effect.fn("Missions.askAgainSoon")(function* (
    environmentIds: Iterable<EnvironmentId>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const environmentId of new Set(environmentIds)) {
      const last = askedAgain.get(environmentId);
      if (last !== undefined && now - last < Duration.toMillis(WORKSPACE_ASK_AGAIN_GAP)) continue;
      askedAgain.set(environmentId, now);
      yield* Ref.update(machinesAsked, (asked) => new Set(asked).add(environmentId));
      yield* retryWaiting;
    }
  });

  /**
   * The members and what each is doing, numbered. With `named`, also the titles, projects and
   * machine labels, which only the roster tool returns, as data. A turn reads it without.
   */
  const members = Effect.fn("Missions.members")(function* (missionId: string, named: boolean) {
    const held = yield* machines;
    const view = yield* missionView(yield* missionNamed(missionId), held, yield* shown);
    const labels = named ? yield* machineLabels : new Map<EnvironmentId, string>();
    const details = yield* Ref.get(remoteDetails);
    const listed = view.members.filter(
      (member) =>
        member.role === "member" && (member.state === "active" || member.state === "offline"),
    );
    const numbered = yield* numbers(
      missionId,
      listed.map((member) => member.ref),
    );
    const rows: Array<RosterMember> = [];
    for (const { ref, state } of listed) {
      const local = ref.environmentId === here;
      const remote = local ? undefined : details.get(ref.environmentId)?.get(ref.threadId);
      const claim = held
        .get(ref.environmentId)
        ?.claims.find((known) => known.threadId === ref.threadId && known.missionId === missionId);
      const detail: MemberDetail | undefined = local
        ? named
          ? yield* memberDetail(ref.threadId).pipe(Effect.provide(readServices))
          : yield* threads.getThreadShell(ref.threadId).pipe(
              Effect.map((shell) =>
                shell === null || shell.deletedAt !== null
                  ? undefined
                  : { status: memberStatusOf(shell), title: "", project: "" },
              ),
              Effect.orElseSucceed(() => undefined),
            )
        : remote?.detail;
      const workspace =
        local || (remote?.missionId === missionId && remote.generation === claim?.generation)
          ? detail?.workspace
          : undefined;
      if (local && detail === undefined) continue;
      rows.push({
        ref,
        ...numbered.get(numberKey(ref))!,
        machine: !named
          ? ""
          : local
            ? "this machine"
            : (labels.get(ref.environmentId) ?? ref.environmentId),
        project: named ? (detail?.project ?? "") : "",
        // An older member machine lists no detail, so its members read as unseen.
        status: state === "offline" || detail === undefined ? "offline" : detail.status,
        title: named ? (detail?.title ?? "") : "",
        ...(named && workspace !== undefined ? { workspace } : {}),
      });
    }
    if (named) {
      yield* askAgainSoon(
        rows.flatMap(({ ref, workspace }) =>
          ref.environmentId !== here &&
          (workspace === "pending" ||
            workspace === "omitted" ||
            (typeof workspace === "object" && workspace.stale))
            ? [ref.environmentId]
            : [],
        ),
      );
    }
    return rows;
  });

  const roster = (missionId: string) => members(missionId, true);
  const memberStatuses = (missionId: string) => members(missionId, false);

  /**
   * A fork starts from its source's history, so a fork of a thread that leads or led a Mission
   * holds that Mission's instructions too. It is told it leads none, for its context only: its
   * own claim, and so the lead tools, stay as they are.
   */
  const forkedFromLead = Effect.fn("Missions.forkedFromLead")(function* (threadId: ThreadId) {
    // One thread row each, deleted ones too: a deleted fork between still passes the history on.
    const lineageOf = (id: ThreadId) =>
      projections.findThread(id).pipe(
        Effect.map((thread) => thread?.lineage ?? null),
        Effect.orElseSucceed(() => null),
      );
    const seen = new Set<ThreadId>([threadId]);
    let lineage = yield* lineageOf(threadId);
    for (let hop = 0; hop < FORK_WALK_HOPS && lineage?.relationshipToParent === "fork"; hop++) {
      const source = lineage.parentThreadId;
      if (source === null || seen.has(source)) return false;
      seen.add(source);
      if (yield* store.ledBefore(source)) return true;
      lineage = yield* lineageOf(source);
    }
    return false;
  });

  yield* turnContexts.serve((threadId) =>
    Effect.gen(function* () {
      const mission = yield* ledBy(threadId);
      if (mission === undefined) {
        return (yield* store.ledBefore(threadId)) || (yield* forkedFromLead(threadId))
          ? { role: "former-lead" as const }
          : undefined;
      }
      const { missionDefaultPrompt } = yield* settings.getSettings;
      return {
        role: "lead" as const,
        prompt: missionPromptText(mission.missionId, mission.prompt || missionDefaultPrompt),
        status: missionStatusText(yield* members(mission.missionId, false)),
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A mission lead's context was not read", cause).pipe(
          Effect.as(undefined),
        ),
      ),
    ),
  );

  const setPrompt = Effect.fn("Missions.setPrompt")(function* (input: {
    readonly missionId: string;
    readonly prompt: string;
  }) {
    yield* store.setPrompt({ missionId: input.missionId, prompt: input.prompt.trim() });
  });

  const withLead = <A, E, R>(
    missionId: string,
    use: (mission: MissionRecord) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A | undefined, E, R> =>
    missionLocks.withLock(
      missionId,
      Effect.flatMap(store.missions, (missions) => {
        const mission = missions.find((candidate) => candidate.missionId === missionId);
        return mission === undefined ? Effect.undefined : use(mission);
      }),
    );

  const heardInWait = Effect.fn("Missions.heardInWait")(function* (
    lead: ThreadId,
    member: ScopedThreadRef,
    runId: string,
  ) {
    const mission = yield* ledBy(lead);
    if (mission === undefined) return;
    yield* withLead(mission.missionId, (now) =>
      now.leadThreadId === lead
        ? store.dropMissionUpdate({
            missionId: now.missionId,
            ...member,
            source: `run:${runId}`,
            event: "completed",
          })
        : Effect.void,
    );
  });

  const joinStarted = Effect.fn("Missions.joinStarted")(function* (
    input: { readonly missionId: string; readonly member: ScopedThreadRef },
    asLead: ThreadId,
  ) {
    const started = yield* store.startJoin(
      { ...input.member, missionId: input.missionId },
      yield* random.uuidV4().pipe(Effect.orDie),
    );
    if (started.state === "released") return undefined;
    if (started.state === "requested") {
      // A start asked before. Its join stands, unless a stop came before it was made.
      const held = (yield* machines)
        .get(input.member.environmentId)
        ?.claims.some(
          (claim) =>
            claim.threadId === input.member.threadId && claim.missionId === input.missionId,
        );
      const asked = (yield* store.pendingAdds).some(
        (add) => memberKey(add) === memberKey(input.member) && add.missionId === input.missionId,
      );
      if (held === true || asked) return undefined;
    }
    // The same add as the first time: a machine that spent it, as the member left since, says so.
    const added = yield* addWithIntent({ ...input, noBrief: true }, asLead, started.intentId);
    return added === "spent" ? undefined : added;
  });

  const leaveHere = Effect.fn("Missions.leaveHere")(function* (
    threadId: ThreadId,
    missionId?: string,
  ) {
    const claim = yield* store.claim(threadId);
    yield* claims.leaveHere(threadId, missionId);
    if (claim !== undefined) {
      yield* store.startedReleased({
        environmentId: here,
        threadId,
        missionId: claim.missionId,
      });
    }
  });

  return Missions.of({
    joinStarted,
    withLead,
    leadChanges: Stream.fromPubSub(leadChanged),
    joinedWithPriorWork: Stream.fromPubSub(joined),
    hasPriorWork,
    ledBy,
    heardInWait,
    roster,
    memberStatuses,
    setPrompt,
    remoteChanges: Stream.fromPubSub(remoteChanged),
    watch,
    create,
    setLead,
    deleteMission,
    addMember,
    releaseMember,
    forgetMember,
    leaveHere,
    numbers,
  });
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
