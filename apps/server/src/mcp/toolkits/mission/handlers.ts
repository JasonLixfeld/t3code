import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { applyMissionTags } from "../../../missions/MissionTags.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MissionToolkit } from "./tools.ts";

// Only a linked environment's session can call it (see `shownOnlyToLinks`). `writesThreads`
// holds a link below full access to the threads it started, as for any linked write.
export const layer = McpToolAccess.toLayer(MissionToolkit, {
  t3_mission_tag: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      applyMissionTags(input.threadId, {
        kind: input.change,
        missionId: input.missionId,
        name: input.name,
      }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "thread-gone" ? "thread_not_found" : "invalid_request",
              message: error.message,
            }),
        ),
        Effect.as({ threadId: input.threadId }),
      ),
  ),
});
