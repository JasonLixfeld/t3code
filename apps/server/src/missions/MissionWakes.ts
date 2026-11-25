import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { MissionStore } from "./MissionStore.ts";
import { Missions } from "./Missions.ts";
import {
  type MemberStatus,
  missionUpdateText,
  type MissionUpdateEvent,
  updateFor,
  updateFromEvent,
} from "./missionStatus.ts";

/** A lead is woken at most this often. What happens in between goes in its next wake. */
export const WAKE_INTERVAL = Duration.seconds(30);

/** Each update is told once, though its event may be written again. */
const TOLD_KEPT = 1_000;

const keyOf = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);

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
    const random = yield* SecureRandom.SecureRandom;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const scope = yield* Effect.scope;

    const seen = new Map<string, MemberStatus>();
    const told = new Set<string>();
    const lastWake = new Map<string, number>();
    const timed = new Set<string>();
    const due = yield* Queue.unbounded<string>();

    const shellOf = (threadId: ThreadId) =>
      threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

    const record = Effect.fn("MissionWakes.record")(function* (
      missionId: string,
      ref: ScopedThreadRef,
      event: MissionUpdateEvent,
    ) {
      yield* store.addMissionUpdate({ missionId, ...ref, event });
      yield* Queue.offer(due, missionId);
    });

    const observeRemote = Effect.fn("MissionWakes.observeRemote")(function* (
      missionId: string,
      ref: ScopedThreadRef,
      status: MemberStatus,
    ) {
      const event = updateFor(seen.get(keyOf(ref)), status);
      seen.set(keyOf(ref), status);
      if (event !== undefined) yield* record(missionId, ref, event);
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
      if (event.type !== "run.updated" && event.type !== "runtime-request.updated") return;
      const claim = yield* missionOf(event.threadId);
      if (claim === undefined) return;
      // A lead whose run ended may now hear what waited for it.
      if (claim.role === "lead") return yield* Queue.offer(due, claim.missionId);
      const update = updateFromEvent(event);
      if (update === undefined || told.has(update.key)) return;
      told.add(update.key);
      if (told.size > TOLD_KEPT) told.delete(told.values().next().value!);
      yield* record(
        claim.missionId,
        { environmentId: here, threadId: event.threadId },
        update.event,
      );
    });

    const deliver = Effect.fn("MissionWakes.deliver")(function* (missionId: string) {
      const updates = (yield* store.missionUpdates).filter(
        (update) => update.missionId === missionId,
      );
      if (updates.length === 0) return;
      const mission = (yield* store.missions).find((found) => found.missionId === missionId);
      const lead = mission === undefined ? null : yield* shellOf(mission.leadThreadId);
      if (mission === undefined || parked(lead)) return yield* store.clearMissionUpdates(updates);
      if (lead!.activeRunId !== null) return;
      const now = yield* Clock.currentTimeMillis;
      const next =
        (lastWake.get(missionId) ?? Number.NEGATIVE_INFINITY) + Duration.toMillis(WAKE_INTERVAL);
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
      const roster = yield* missions
        .roster(missionId)
        .pipe(Effect.orElseSucceed(() => [] as const));
      const placeOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
        roster.find(
          (row) => row.ref.environmentId === environmentId && row.ref.threadId === threadId,
        );
      const id = yield* random.uuidV4().pipe(Effect.orDie);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:mission-update:${id}`),
        threadId: mission.leadThreadId,
        messageId: MessageId.make(`message:mission-update:${id}`),
        text: missionUpdateText(
          updates.map((update) => {
            const place = placeOf(update.environmentId, update.threadId);
            return {
              ref: update,
              machine:
                place?.machine ??
                (update.environmentId === here ? "this machine" : update.environmentId),
              project: place?.project ?? "",
              event: update.event,
            };
          }),
        ),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      lastWake.set(missionId, now);
      yield* store.clearMissionUpdates(updates);
    });

    for (const update of yield* store.missionUpdates) yield* Queue.offer(due, update.missionId);

    const logged = (message: string) =>
      Effect.catchCause((cause) => Effect.logError(message, cause));
    yield* Queue.take(due).pipe(
      Effect.flatMap((missionId) =>
        deliver(missionId).pipe(logged("A mission update was not delivered")),
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
      Stream.runForEach((change) => observeRemote(change.missionId, change.ref, change.status)),
      logged("Mission wakes stopped following other machines"),
      Effect.forkIn(scope),
    );
  }),
);
