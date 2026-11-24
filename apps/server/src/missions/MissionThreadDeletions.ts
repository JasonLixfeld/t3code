import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MissionClaims from "./MissionClaims.ts";

/**
 * A member thread deleted here leaves its Mission, as Leave mission does, so its lead stops
 * listing it. An unused side chat T3 deletes on its own goes the same way. A deleted lead keeps
 * its claim: its Mission shows the lead as gone and can take a new one.
 */
export const releaseDeletedThreads = <E>(
  events: Stream.Stream<{ readonly type: string; readonly threadId: ThreadId }, E>,
) =>
  Effect.flatMap(MissionClaims.MissionClaims, (claims) =>
    Stream.runForEach(events, (event) =>
      event.type === "thread.deleted"
        ? claims
            .leaveHere(event.threadId)
            .pipe(Effect.catchTags({ MissionError: () => Effect.void }))
        : Effect.void,
    ),
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* releaseDeletedThreads(engine.streamDomainEvents).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Mission thread deletions stopped", cause)),
      Effect.forkScoped,
    );
  }),
);
