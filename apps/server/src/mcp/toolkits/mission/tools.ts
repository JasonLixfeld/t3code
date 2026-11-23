import { MissionId, MissionName, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { MissionClaimKind, MissionClaims } from "../../../missions/MissionClaims.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only to a linked environment's session: agents never see or call it. */
const shownOnlyToLinks = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.client?.linked === true;
};

/** `join` needs threadId, missionId and name; `release` threadId, missionId and generation. */
const MissionTagInput = Schema.Struct({
  kind: MissionClaimKind,
  threadId: Schema.optional(ThreadId),
  missionId: Schema.optional(MissionId),
  name: Schema.optional(MissionName),
  generation: Schema.optional(Schema.String),
});

export const MissionClaimResult = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      missionId: Schema.String,
      name: Schema.String,
      role: Schema.Literals(["lead", "member"]),
      generation: Schema.String,
    }),
  ),
});

export const MissionToolkit = Toolkit.make(
  Tool.make("t3_mission_tag", {
    description:
      "For a linked T3 environment only: mark a thread here as joining or leaving a mission there.",
    parameters: MissionTagInput,
    success: MissionClaimResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      MissionClaims,
    ],
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, shownOnlyToLinks),
);
