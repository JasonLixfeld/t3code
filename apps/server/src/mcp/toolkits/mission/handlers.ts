import { MissionError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { linkOwner, MissionClaims } from "../../../missions/MissionClaims.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MissionToolkit } from "./tools.ts";

const needs = <A>(value: A | undefined, field: string) =>
  value === undefined
    ? Effect.fail(new MissionError({ message: `This kind of call needs ${field}.` }))
    : Effect.succeed(value);

// Only a linked environment's session can call it (see `shownOnlyToLinks`). `writesThreads`
// holds a link below full access to the threads it started, and the claim code makes that check
// again under the thread's lock. A release drops only a claim its own caller holds.
export const layer = McpToolAccess.toLayer(MissionToolkit, {
  t3_mission_tag: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const claims = yield* MissionClaims;
        const mayChange = yield* McpToolAccess.threadWriteAccess;
        // The owner comes from the authenticated caller, never from the input.
        const owner =
          scope.client === undefined ? scope.environmentId : linkOwner(scope.client.sessionId);
        if (input.kind === "list") return yield* claims.list(owner);
        // Renames only claims this caller already holds, so it changes no thread it could not.
        if (input.kind === "rename") {
          return yield* claims.rename(owner, {
            missionId: yield* needs(input.missionId, "missionId"),
            name: yield* needs(input.name, "name"),
          });
        }
        const threadId = yield* needs(input.threadId, "threadId");
        switch (input.kind) {
          case "join": {
            const joined = yield* claims.join(
              owner,
              {
                threadId,
                missionId: yield* needs(input.missionId, "missionId"),
                name: yield* needs(input.name, "name"),
                intentId: input.intentId,
              },
              mayChange,
            );
            return joined === "intent-spent" ? [] : [joined];
          }
          case "release":
            yield* claims.release(
              owner,
              {
                threadId,
                missionId: yield* needs(input.missionId, "missionId"),
                generation: yield* needs(input.generation, "generation"),
              },
              mayChange,
            );
            return [];
        }
      }).pipe(
        Effect.map((claims) => ({ claims })),
        Effect.catchTags({
          MissionError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
        }),
      ),
  ),
});
