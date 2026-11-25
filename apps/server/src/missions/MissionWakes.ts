import {
  CommandId,
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
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { MissionStore, type MissionRecord, numberKey } from "./MissionStore.ts";
import { Missions } from "./Missions.ts";
import {
  type MemberDetail,
  markOf,
  missionUpdateText,
  remoteUpdates,
  type SourcedUpdate,
  updateFromEvent,
} from "./missionStatus.ts";

/** A lead is woken at most this often. What happens in between goes in its next wake. */
export const WAKE_INTERVAL = Duration.seconds(30);

/** Sources already recorded, since a run's ending may be written again after it was told. */
const TOLD_KEPT = 1_000;

const parked = (lead: OrchestrationV2ThreadShell | null) =>
  lead === null ||
  lead.deletedAt !== null ||
  lead.archivedAt !== null ||
  lead.settledAt !== null ||
  lead.settledOverride === "settled";

/**
 * Wakes a mission's lead when a member needs it or ends a turn, as delegated results reach their
 * parent: in one message once the lead is idle, at most once per WAKE_INTERVAL. Starting work wakes
 * no one, so the lead's own sends cannot loop. Untold updates stay on disk across a restart.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* Missions;
    const store = yield* MissionStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const scope = yield* Effect.scope;

    // By lead thread: a new lead is a new reader, and its first wake need not wait.
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

    /** Compared with what the member last said, kept on disk, so a restart misses nothing. */
    const observeRemote = Effect.fn("MissionWakes.observeRemote")(function* (
      missionId: string,
      ref: ScopedThreadRef,
      detail: MemberDetail,
    ) {
      const before = yield* store.memberMark(ref);
      yield* record(missionId, ref, remoteUpdates(before, detail, yield* Clock.currentTimeMillis));
      yield* store.setMemberMark(ref, markOf(detail));
    });

    /** The Mission led here that a thread here belongs to, and how. */
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
      if (
        event.type !== "run.updated" &&
        event.type !== "runtime-request.updated" &&
        event.type !== "turn-item.updated"
      ) {
        return;
      }
      // Read first: most turn items are text, and they cost no lookup.
      const update = updateFromEvent(event);
      if (update === undefined && event.type !== "run.updated") return;
      const claim = yield* missionOf(event.threadId);
      if (claim === undefined) return;
      // A lead whose run ended may now hear what waited for it.
      if (claim.role === "lead") return yield* Queue.offer(due, claim.missionId);
      if (update === undefined) return;
      yield* record(claim.missionId, { environmentId: here, threadId: event.threadId }, [update]);
    });

    /** Puts away every update of a Mission whose lead may not be woken. */
    const dropUpdates = (missionId: string, lead: ThreadId): Effect.Effect<void> =>
      Effect.flatMap(store.takeMissionUpdates(missionId, lead), ({ key, updates }) =>
        updates.length === 0
          ? Effect.void
          : Effect.andThen(store.clearMissionUpdates(missionId, key), dropUpdates(missionId, lead)),
      );

    /** Runs under the Mission's lock, so the lead it names stays the lead until it is sent. */
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
      // A wake a stop cut off comes back with its key, so the orchestrator replays it once.
      const { key, updates } = yield* store.takeMissionUpdates(missionId, leadThreadId);
      if (updates.length === 0) return;
      const names = yield* missions.numbers(missionId, updates);
      const sent = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:mission-update:${missionId}:${key}`),
          threadId: leadThreadId,
          messageId: MessageId.make(`message:mission-update:${missionId}:${key}`),
          text: missionUpdateText(
            updates.map((update) => ({ ...names.get(numberKey(update))!, event: update.event })),
          ),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          // A lead settled since the read above stays settled; its updates go with this one.
          Effect.provideService(Orchestrator.UnlessParked, true),
          Effect.result,
        );
      if (Result.isFailure(sent)) {
        // Turned down: sending the same command again would only replay that. Its updates go
        // with the next wake, under a new key.
        yield* store.rekeyMissionUpdates(missionId, key);
        return yield* sent.failure;
      }
      lastWake.set(leadThreadId, now);
      yield* store.clearMissionUpdates(missionId, key);
    });

    for (const missionId of yield* store.missionsWithUpdates) yield* Queue.offer(due, missionId);

    const logged = (message: string) =>
      Effect.catchCause((cause) => Effect.logWarning(message, cause));
    yield* Queue.take(due).pipe(
      Effect.flatMap((missionId) =>
        missions.withLead(missionId, deliverTo).pipe(logged("A mission update was not delivered")),
      ),
      Effect.forever,
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
        observeRemote(change.missionId, change.ref, change.detail).pipe(
          logged("A remote member's change was not read"),
        ),
      ),
      Effect.forkIn(scope),
    );
    yield* missions.leadChanges.pipe(
      Stream.runForEach((missionId) => Queue.offer(due, missionId)),
      Effect.forkIn(scope),
    );
  }),
);
