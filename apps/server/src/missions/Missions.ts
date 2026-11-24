import {
  type EnvironmentId,
  isMissionTag,
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
  type PendingAdd,
  type PendingRelease,
} from "./MissionStore.ts";

/** How long a lead waits on a member's machine before it treats the outcome as unknown. */
export const MEMBER_CALL_DEADLINE = Duration.seconds(10);
/** How often a lead asks its linked machines again, while a client watches or a release waits. */
export const REFRESH_INTERVAL = Duration.seconds(15);
/**
 * How long an add may wait for its machine before the lead stops sending it. Well inside the time
 * a member's machine remembers a spent add, so a lead restored from a backup cannot replay one.
 */
export const PENDING_ADD_DAYS = 7;

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
    /** Leaves the add pending when the member's machine does not say what became of it. */
    readonly addMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /** Leaves the release pending when the member's machine cannot be reached. */
    readonly releaseMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /** Stops waiting on a thread whose add or release its machine has not answered. Sends nothing. */
    readonly forgetMember: (input: {
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
    }
  | {
      readonly kind: "release";
      readonly threadId: ThreadId;
      readonly missionId: string;
      readonly generation: string;
    }
  | { readonly kind: "list" }
  | { readonly kind: "rename"; readonly missionId: string; readonly name: string };

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
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const random = yield* SecureRandom.SecureRandom;
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
    const releasing = waiting.releases.filter((release) => release.missionId === mission.missionId);
    for (const [environmentId, machine] of held) {
      for (const claim of machine.claims) {
        if (claim.missionId !== mission.missionId || claim.role === "lead") continue;
        // A member deleted here is no longer one, whether or not its claim was let go yet.
        if (environmentId === here && (yield* threadGone(claim.threadId))) continue;
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
    return {
      missions: yield* Effect.forEach(yield* store.missions, (mission) =>
        missionView(mission, held, owed),
      ),
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
  ): Effect.fn.Return<ReadonlyArray<MissionClaim>, MissionError | Unreachable> {
    if (environmentId === here) {
      switch (call.kind) {
        case "join": {
          const joined = yield* claims.join(here, { ...call, ledHere: true });
          return joined === "intent-spent" ? [] : [joined];
        }
        case "release":
          yield* claims.release(here, call);
          return [];
        case "list":
          return yield* claims.list(here);
        case "rename":
          return yield* claims.rename(here, call);
      }
    }
    const { label } = yield* linkTo(environmentId).pipe(
      Effect.catch((error) =>
        setAnswering(environmentId, false).pipe(
          Effect.andThen(Effect.fail(new Unreachable({ message: error.message }))),
        ),
      ),
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
    yield* setAnswering(environmentId, unreachable === undefined);
    if (unreachable !== undefined) return yield* new Unreachable({ message: unreachable });
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

  /**
   * Call only under the machine's lock. Any answer settles the add: the claim it made, or no
   * claim when the thread has left since, which spends the add there. A join is safe to send
   * again, because every copy names the same add and gets the one claim that add made.
   */
  const sendJoin = Effect.fn("Missions.sendJoin")(function* (
    mission: MissionRecord,
    add: Omit<PendingAdd, "refusal">,
  ) {
    // Read again under the machine's lock: a rename since the add began must not be lost.
    const { name } = yield* missionNamed(mission.missionId);
    const [claim] = yield* onMember(add.environmentId, {
      kind: "join",
      threadId: add.threadId,
      missionId: mission.missionId,
      name,
      intentId: add.intentId,
    });
    // This machine's own threads have no pending row, and their claims are read, not remembered.
    if (add.environmentId === here) return;
    yield* claim === undefined ? store.clearPendingAdd(add) : store.settleAdd(add, claim);
  });

  const refreshMachine = (environmentId: EnvironmentId, discover: boolean) =>
    machineLocks.withLock(
      environmentId,
      Effect.gen(function* () {
        for (const release of yield* store.pendingReleases) {
          if (release.environmentId === environmentId) yield* sendRelease(release);
        }
        const missions = yield* store.missions;
        for (const add of yield* store.pendingAdds) {
          const mission = missions.find((candidate) => candidate.missionId === add.missionId);
          if (add.environmentId !== environmentId || add.refusal !== null) continue;
          if (mission === undefined) yield* store.clearPendingAdd(add);
          else {
            const stale = yield* staleAdd(add);
            if (stale !== undefined) {
              yield* store.expireAdd({ ...add, refusal: stale });
              continue;
            }
            yield* sendJoin(mission, add).pipe(
              Effect.catchTags({
                MissionError: (error) => store.setPendingAdd({ ...add, refusal: error.message }),
              }),
            );
          }
        }
        // Only a list settles an add no answer came for, so such a machine is listed every time.
        const uncertain = (yield* store.uncertainAdds).some(
          (add) => add.environmentId === environmentId,
        );
        if (!discover && !uncertain) return;
        let held = yield* onMember(environmentId, { kind: "list" });
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
      }).pipe(
        Effect.catch((error) => Effect.logInfo("A mission member machine did not answer", error)),
      ),
    );

  /** The machines that owe an answer to an add or a release. They stay in every sweep. */
  const owingAnAnswer = Effect.map(
    Effect.all([waiting, store.uncertainAdds]),
    ([{ releases, adds }, uncertain]) =>
      [...releases, ...adds.filter((add) => add.refusal === null), ...uncertain].map(
        (owed) => owed.environmentId,
      ),
  );
  // Set by whoever wants the machines' claims read again; a sweep without it only sends again
  // what still waits for an answer.
  const discoverNext = yield* Ref.make(false);
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
    yield* followLeadTitles;
    const discover = yield* Ref.getAndSet(discoverNext, false);
    const asked = new Set([
      ...(yield* owingAnAnswer),
      ...(discover ? (yield* store.knownClaims).keys() : []),
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
  const retryWaiting = Queue.offer(sweepRequests, undefined).pipe(Effect.asVoid);
  const refresh = Ref.set(discoverNext, true).pipe(Effect.andThen(retryWaiting));
  yield* Queue.take(sweepRequests).pipe(
    Effect.andThen(sweep),
    Effect.forever,
    Effect.forkIn(background),
  );
  yield* Effect.sleep(REFRESH_INTERVAL).pipe(
    Effect.andThen(Effect.all([Ref.get(watchers), owingAnAnswer])),
    Effect.flatMap(([watching, owing]) =>
      watching > 0 ? refresh : owing.length > 0 ? retryWaiting : Effect.void,
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
    // An add its machine never answered may have made a claim there.
    const { adds } = yield* waiting;
    const [owed] = [
      ...adds.filter((add) => add.refusal === null),
      ...(yield* store.uncertainAdds),
    ].filter((add) => add.missionId === mission.missionId);
    if (owed !== undefined) {
      const label = yield* linkTo(owed.environmentId).pipe(
        Effect.map((link) => link.label),
        Effect.orElseSucceed(() => owed.environmentId as string),
      );
      return yield* fail(`Waiting to hear from ${label}.`);
    }
    // A member whose thread is gone holds nothing back.
    for (const claim of yield* claims.list(here)) {
      if (claim.missionId !== mission.missionId || claim.role !== "member") continue;
      if (yield* threadGone(claim.threadId)) yield* claims.leaveHere(claim.threadId);
    }
    yield* claims.deleteMission({ missionId: mission.missionId, lead: mission.leadThreadId });
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
    const record = yield* claims.setLead(here, {
      missionId: mission.missionId,
      name: missionNameFromTitle(shell?.title ?? ""),
      leadThreadId: input.lead.threadId,
      previous: input.expectedLead,
    });
    return yield* missionView(record, yield* machines, yield* shown);
  });

  const addMember = Effect.fn("Missions.addMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId } = input.member;
    const intentId = yield* random.uuidV4().pipe(Effect.orDie);
    const setSending = (isSending: boolean) =>
      Ref.update(sending, (current) => {
        const next = new Set(current);
        if (isSending) next.add(intentId);
        else next.delete(intentId);
        return next;
      });
    yield* setSending(true);
    yield* machineLocks
      .withLock(
        environmentId,
        Effect.gen(function* () {
          // A link this machine cannot use refuses the add here, before anything is written.
          const linkId = environmentId === here ? "" : (yield* linkTo(environmentId)).linkId;
          const add = {
            ...input.member,
            missionId: mission.missionId,
            intentId,
            linkId,
            addedAt: DateTime.formatIso(yield* DateTime.now),
            refusal: null,
          };
          yield* Effect.gen(function* () {
            // Written before anything is sent. If this call is cut off, or the server stops, the
            // add is still there to send again. This machine's own threads need none.
            if (environmentId !== here) yield* store.setPendingAdd(add);
            // A release of this thread that still waits is finished first. The join then makes
            // a new claim, which that release cannot match if an earlier copy arrives late.
            for (const release of yield* store.pendingReleases) {
              if (memberKey(release) === memberKey(input.member)) yield* sendRelease(release);
            }
            yield* sendJoin(mission, add);
          }).pipe(
            Effect.catchTags({
              // Nobody knows whether the join landed. The add stays, and is sent again, until
              // the thread's machine says what became of it.
              MissionMemberUnreachable: () => refresh,
              MissionError: (error) =>
                store.clearPendingAdd(add).pipe(Effect.andThen(Effect.fail(error))),
            }),
          );
        }),
      )
      .pipe(Effect.ensuring(setSending(false).pipe(Effect.andThen(storeChanged))));
  });

  const releaseMember = Effect.fn("Missions.releaseMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const { environmentId, threadId } = input.member;
    const refused = (yield* store.pendingAdds).find(
      (add) =>
        memberKey(add) === memberKey(input.member) &&
        add.missionId === mission.missionId &&
        add.refusal !== null,
    );
    // The thread never joined, so releasing it only puts the refusal away.
    if (refused !== undefined) return yield* store.clearPendingAdd(refused);
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
            store.addPendingRelease(release).pipe(Effect.andThen(retryWaiting)),
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
        const waits = [...releases, ...adds.filter((add) => add.refusal === null)].some(
          (owed) =>
            memberKey(owed) === memberKey(input.member) && owed.missionId === mission.missionId,
        );
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

  return Missions.of({
    watch,
    create,
    setLead,
    deleteMission,
    addMember,
    releaseMember,
    forgetMember,
    leaveHere: claims.leaveHere,
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
