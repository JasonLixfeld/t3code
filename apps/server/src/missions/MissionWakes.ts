import {
  CommandId,
  type MemberDetail,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { eventCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { MissionStore, type MissionRecord, numberKey } from "./MissionStore.ts";
import { Missions } from "./Missions.ts";
import {
  wasCompletionHeld,
  ATTENTION_LINES,
  missionUpdateText,
  memberUpdates,
  shellDetail,
  type SourcedUpdate,
  updateFromEvent,
} from "./missionStatus.ts";

export const WAKE_INTERVAL = Duration.seconds(30);

export const missionWakeCommand = (input: {
  readonly missionId: string;
  readonly key: string;
  readonly lead: ThreadId;
  readonly text: string;
}) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`server:mission-update:${input.missionId}:${input.key}`),
  threadId: input.lead,
  messageId: MessageId.make(`message:mission-update:${input.missionId}:${input.key}`),
  text: input.text,
  notification: {
    source: { kind: "system" as const },
    outcome: "updated" as const,
    summary: "Mission update",
    detail: input.text,
  },
  attachments: [],
  dispatchMode: { type: "queue_after_active" as const },
  createdBy: "agent" as const,
  creationSource: "server" as const,
});

const TOLD_KEPT = 1_000;

const parked = (lead: OrchestrationV2ThreadShell | null) =>
  lead === null ||
  lead.deletedAt !== null ||
  lead.archivedAt !== null ||
  lead.settledAt !== null ||
  lead.settledOverride === "settled";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* Missions;
    const store = yield* MissionStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const scope = yield* Effect.scope;

    const logged = (message: string) =>
      Effect.catchCause((cause) => Effect.logWarning(message, cause));
    const lastWake = new Map<ThreadId, number>();
    const timed = new Set<string>();
    const told = new Set<string>();
    const due = yield* Queue.unbounded<string>();

    const shellOf = (threadId: ThreadId) =>
      threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

    const record = Effect.fn("MissionWakes.record")(function* (
      missionId: string,
      ref: ScopedThreadRef,
      updates: ReadonlyArray<SourcedUpdate>,
    ) {
      const toldKey = (source: string) =>
        `${ref.environmentId}\u0000${ref.threadId}\u0000${source}`;
      const fresh = updates.filter((update) => !told.has(toldKey(update.source)));
      for (const update of fresh) {
        told.add(toldKey(update.source));
        if (told.size > TOLD_KEPT) told.delete(told.values().next().value!);
        yield* store.addMissionUpdate({ missionId, ...ref, ...update });
      }
      if (fresh.length > 0) yield* Queue.offer(due, missionId);
    });

    const memberObservationLock = yield* Semaphore.make(1);
    const observe = Effect.fn("MissionWakes.observe")(
      function* (
        missionId: string,
        ref: ScopedThreadRef,
        read: Effect.Effect<MemberDetail | undefined>,
        unseen?: string,
        onlyIfHeld = false,
      ) {
        const recorded = yield* store.memberMark(ref);
        if (onlyIfHeld && (recorded === undefined || !wasCompletionHeld(recorded))) return;
        const detail = yield* read;
        if (detail === undefined) return;
        const before = recorded ?? unseen;
        const { updates, mark } = memberUpdates(before, detail, yield* Clock.currentTimeMillis);
        yield* record(missionId, ref, updates);
        yield* store.setMemberMark(ref, mark);
      },
      (effect) => memberObservationLock.withPermits(1)(effect),
    );

    const localDetail = (
      threadId: ThreadId,
      run?: { readonly id: string; readonly status: string },
    ) =>
      Effect.map(shellOf(threadId), (shell) =>
        shell === null || shell.deletedAt !== null ? undefined : shellDetail(shell, run),
      );

    const observeRunWithoutRequests = (
      missionId: string,
      ref: ScopedThreadRef,
      run?: { readonly id: string; readonly status: string },
      onlyIfHeld = false,
    ) =>
      observe(
        missionId,
        ref,
        Effect.flatMap(
          localDetail(ref.threadId, run),
          (detail): Effect.Effect<MemberDetail | undefined> => {
            if (detail !== undefined) return Effect.succeed({ ...detail, requests: [] });
            if (run?.status !== "failed") return Effect.undefined;
            return Effect.as(
              Effect.logWarning("A failed member's thread was not read; its event tells it", {
                threadId: ref.threadId,
              }),
              { status: "failed", title: "", project: "", run, requests: [] },
            );
          },
        ),
        "{}",
        onlyIfHeld,
      );

    const seeLocalMembers = Effect.gen(function* () {
      const led = new Set((yield* store.missions).map((mission) => mission.missionId));
      for (const claim of yield* store.claimsOf(here)) {
        if (claim.role !== "member" || !led.has(claim.missionId)) continue;
        const ref = { environmentId: here, threadId: claim.threadId };
        const mark = yield* store.memberMark(ref);
        if (mark !== undefined) {
          yield* observeRunWithoutRequests(claim.missionId, ref, undefined, true);
          continue;
        }
        yield* observe(claim.missionId, ref, localDetail(claim.threadId));
      }
    });

    const missionOf = Effect.fn("MissionWakes.missionOf")(function* (threadId: ThreadId) {
      const claim = yield* store.claim(threadId);
      if (claim === undefined) return undefined;
      const ledHere = (yield* store.missions).some(
        (mission) => mission.missionId === claim.missionId,
      );
      return ledHere ? claim : undefined;
    });

    const onThreadEvent = Effect.fn("MissionWakes.onThreadEvent")(function* (
      event: OrchestrationV2DomainEvent,
    ) {
      if (event.type === "thread.unsettled" || event.type === "thread.unarchived") {
        const claim = yield* missionOf(event.threadId);
        if (claim?.role === "lead") yield* Queue.offer(due, claim.missionId);
        return;
      }
      const update =
        event.type === "run.updated" ||
        event.type === "runtime-request.updated" ||
        event.type === "turn-item.updated"
          ? updateFromEvent(event)
          : undefined;
      const run = event.type === "run.updated";
      if (update === undefined && !run && !eventCanEndBackgroundWork(event)) return;
      const claim = yield* missionOf(event.threadId);
      if (claim === undefined) return;
      if (claim.role === "lead") {
        if (run || update !== undefined) yield* Queue.offer(due, claim.missionId);
        return;
      }
      const ref = { environmentId: here, threadId: event.threadId };
      const ofRun =
        event.type === "run.updated"
          ? { id: event.payload.id, status: event.payload.status }
          : undefined;
      if (update !== undefined && ofRun !== undefined)
        return yield* observeRunWithoutRequests(claim.missionId, ref, ofRun);
      if (update !== undefined) return yield* record(claim.missionId, ref, [update]);
      yield* observeRunWithoutRequests(claim.missionId, ref, ofRun, true);
    });

    const dropUpdates = (missionId: string, lead: ThreadId): Effect.Effect<void> =>
      Effect.flatMap(store.takeMissionUpdates(missionId, lead), ({ key, updates }) => {
        if (updates.length === 0) return Effect.void;
        const joins = updates.filter((update) => update.event === "joined");
        return Effect.andThen(
          store.clearMissionUpdates(missionId, key, joins),
          joins.length === updates.length ? Effect.void : dropUpdates(missionId, lead),
        );
      });

    const joinedStatuses = Effect.fn("MissionWakes.joinedStatuses")(function* (
      missionId: string,
      updates: ReadonlyArray<ScopedThreadRef & { readonly event: string }>,
    ) {
      const statuses = new Map<string, string>();
      if (!updates.some((update) => update.event === "joined")) return statuses;
      for (const row of yield* missions.memberStatuses(missionId)) {
        if (row.ref.environmentId !== here) {
          const listed = (yield* store.memberMark(row.ref)) !== undefined;
          statuses.set(numberKey(row.ref), listed ? row.status : "unknown");
          continue;
        }
        const shell = yield* shellOf(row.ref.threadId);
        statuses.set(numberKey(row.ref), parked(shell) ? "settled" : row.status);
      }
      return statuses;
    });

    const deliverTo = Effect.fn("MissionWakes.deliverTo")(function* (mission: MissionRecord) {
      const { missionId, leadThreadId } = mission;
      const lead = yield* shellOf(leadThreadId);
      if (parked(lead)) return yield* dropUpdates(missionId, leadThreadId);
      if (lead!.activeRunId !== null) return;
      const now = yield* Clock.currentTimeMillis;
      const next =
        (lastWake.get(leadThreadId) ?? Number.NEGATIVE_INFINITY) + Duration.toMillis(WAKE_INTERVAL);
      if (now < next) {
        if (timed.has(missionId)) return;
        timed.add(missionId);
        yield* Effect.sleep(Duration.millis(next - now)).pipe(
          Effect.andThen(Effect.sync(() => timed.delete(missionId))),
          Effect.andThen(Queue.offer(due, missionId)),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        return;
      }
      const { key, updates } = yield* store.takeMissionUpdates(missionId, leadThreadId);
      if (updates.length === 0) return;
      const names = yield* missions.numbers(missionId, updates);
      const statuses = yield* joinedStatuses(missionId, updates);
      const sent = yield* threads
        .dispatch(
          missionWakeCommand({
            missionId,
            key,
            lead: leadThreadId,
            text: missionUpdateText(
              updates.map((update) => ({
                ...names.get(numberKey(update))!,
                event: update.event,
                status: statuses.get(numberKey(update)),
              })),
            ),
          }),
        )
        .pipe(Effect.provideService(Orchestrator.UnlessParked, true), Effect.result);
      if (Result.isFailure(sent)) {
        yield* store.rekeyMissionUpdates(missionId, key);
        return yield* sent.failure;
      }
      lastWake.set(leadThreadId, now);
      const held = updates.slice(ATTENTION_LINES);
      yield* store.clearMissionUpdates(missionId, key, held);
      if (held.length > 0) yield* Queue.offer(due, missionId);
    });

    for (const missionId of yield* store.missionsWithUpdates) yield* Queue.offer(due, missionId);
    const storeChanges = yield* PubSub.subscribe(store.changes);

    yield* Queue.take(due).pipe(
      Effect.flatMap((missionId) =>
        missions.withLead(missionId, deliverTo).pipe(logged("A mission update was not delivered")),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
    const lookHere = seeLocalMembers.pipe(logged("A member that joined here was not looked at"));
    yield* lookHere.pipe(
      Effect.andThen(Stream.fromSubscription(storeChanges).pipe(Stream.runForEach(() => lookHere))),
      Effect.forkIn(scope),
    );
    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        onThreadEvent(event).pipe(logged("A mission member's change was not read")),
      ),
      logged("Mission wakes stopped following threads"),
      Effect.forkIn(scope),
    );
    yield* missions.remoteChanges.pipe(
      Stream.runForEach((change) =>
        observe(change.missionId, change.ref, Effect.succeed(change.detail)).pipe(
          logged("A remote member's change was not read"),
        ),
      ),
      Effect.forkIn(scope),
    );
    yield* missions.leadChanges.pipe(
      Stream.merge(missions.joinedWithPriorWork),
      Stream.runForEach((missionId) => Queue.offer(due, missionId)),
      Effect.forkIn(scope),
    );
  }),
);
