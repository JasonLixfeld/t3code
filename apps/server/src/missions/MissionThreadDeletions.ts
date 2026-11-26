import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MissionClaims from "./MissionClaims.ts";
import { MissionStore } from "./MissionStore.ts";

/** Each one changes whether a member reads as settled in the Missions list. */
const SETTLEMENT_CHANGES: ReadonlySet<string> = new Set([
  "thread.settled",
  "thread.unsettled",
  "thread.archived",
  "thread.unarchived",
]);

export const followMemberThreads = Effect.fn("MissionThreadDeletions.followMemberThreads")(
  function* <E>(
    events: Stream.Stream<{ readonly type: string; readonly threadId: ThreadId }, E>,
    here: EnvironmentId,
  ) {
    const claims = yield* MissionClaims.MissionClaims;
    const store = yield* MissionStore;
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "thread.deleted") {
        return claims
          .leaveHere(event.threadId)
          .pipe(
            Effect.catchTags({ MissionError: () => Effect.void }),
            Effect.andThen(
              store.forgetStartedJoin({ environmentId: here, threadId: event.threadId }),
            ),
          );
      }
      if (!SETTLEMENT_CHANGES.has(event.type)) return Effect.void;
      return store
        .claim(event.threadId)
        .pipe(
          Effect.flatMap((claim) =>
            claim === undefined ? Effect.void : PubSub.publish(store.changes, undefined),
          ),
        );
    });
  },
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    yield* followMemberThreads(engine.streamDomainEvents, here).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Missions stopped following their member threads", cause),
      ),
      Effect.forkScoped,
    );
  }),
);
