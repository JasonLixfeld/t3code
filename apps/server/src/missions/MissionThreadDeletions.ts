import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MissionClaims from "./MissionClaims.ts";
import { MissionStore } from "./MissionStore.ts";
import * as Missions from "./Missions.ts";

const MISSION_SETTLEMENT_INVALIDATION_EVENTS: ReadonlySet<string> = new Set([
  "thread.settled",
  "thread.unsettled",
  "thread.pinned",
  "thread.guest-share-updated",
  "thread.archived",
  "thread.unarchived",
]);

interface ThreadEvent {
  readonly type: string;
  readonly threadId: ThreadId;
  readonly occurredAt: DateTime.Utc;
}

export const followMemberThreads = Effect.fn("MissionThreadDeletions.followMemberThreads")(
  function* <E>(
    events: Stream.Stream<ThreadEvent, E>,
    here: EnvironmentId,
    listStale: Effect.Effect<void>,
  ) {
    const claims = yield* MissionClaims.MissionClaims;
    const store = yield* MissionStore;
    const missions = yield* Missions.Missions;
    const endAttempts = yield* FiberSet.make<void>();
    const follow = Effect.fnUntraced(function* (event: ThreadEvent) {
      if (event.type === "thread.deleted") {
        yield* claims
          .leaveHere(event.threadId)
          .pipe(Effect.catchTags({ MissionError: () => Effect.void }));
        return yield* store.forgetStartedJoin({ environmentId: here, threadId: event.threadId });
      }
      if (!MISSION_SETTLEMENT_INVALIDATION_EVENTS.has(event.type)) return;
      const claim = yield* store.claim(event.threadId);
      if (claim === undefined) return;
      yield* listStale;
      if (event.type !== "thread.settled" || claim.role !== "lead") return;
      yield* FiberSet.run(
        endAttempts,
        missions.endIfLeadSettled(
          { missionId: claim.missionId, leadThreadId: event.threadId },
          event.occurredAt,
        ),
      );
    });
    yield* Stream.runForEach(events, (event) =>
      follow(event).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("A mission did not follow a thread change", cause),
        ),
      ),
    );
    yield* FiberSet.awaitEmpty(endAttempts);
  },
  Effect.scoped,
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const missions = yield* Missions.Missions;
    yield* followMemberThreads(engine.streamDomainEvents, here, missions.listStale).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Missions stopped following their member threads", cause),
      ),
      Effect.forkScoped,
    );
  }),
);
