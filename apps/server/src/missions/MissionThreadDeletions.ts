import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MissionClaims from "./MissionClaims.ts";
import { MissionStore } from "./MissionStore.ts";

export const releaseDeletedThreads = Effect.fn("MissionThreadDeletions.releaseDeletedThreads")(
  function* <E>(
    events: Stream.Stream<{ readonly type: string; readonly threadId: ThreadId }, E>,
    here: EnvironmentId,
  ) {
    const claims = yield* MissionClaims.MissionClaims;
    const store = yield* MissionStore;
    yield* Stream.runForEach(events, (event) =>
      event.type === "thread.deleted"
        ? claims
            .leaveHere(event.threadId)
            .pipe(
              Effect.catchTags({ MissionError: () => Effect.void }),
              Effect.andThen(
                store.forgetStartedJoin({ environmentId: here, threadId: event.threadId }),
              ),
            )
        : Effect.void,
    );
  },
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    yield* releaseDeletedThreads(engine.streamDomainEvents, here).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Mission thread deletions stopped", cause)),
      Effect.forkScoped,
    );
  }),
);
