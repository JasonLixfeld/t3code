import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { MissionTagChangeKind } from "../../../missions/MissionTags.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only to a linked environment's session: agents never see or call it. */
const shownOnlyToLinks = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.client?.linked === true;
};

const MissionTagInput = Schema.Struct({
  threadId: ThreadId,
  change: MissionTagChangeKind,
  missionId: Schema.String,
  name: Schema.String,
});

export const MissionToolkit = Toolkit.make(
  Tool.make("t3_mission_tag", {
    description:
      "For linked T3 environments only: mark a thread here as joining or leaving a mission.",
    parameters: MissionTagInput,
    success: Schema.Struct({ threadId: ThreadId }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      SecureRandom.SecureRandom,
    ],
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, shownOnlyToLinks),
);
