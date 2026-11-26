import {
  clampedPositiveInt,
  EnvironmentId,
  ListedWorkspace,
  MemberStatus,
  MissionClaimResult,
  MissionTagInput,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { MissionClaims } from "../../../missions/MissionClaims.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shownOnlyToLinks = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.client?.linked === true;
};

/** Omit `environmentId` for a thread on this machine. */
const MissionThreadRef = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.optional(EnvironmentId),
});

const leadOnly = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

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
  Tool.make("t3_mission_roster", {
    description:
      "List the member threads of the mission you lead: machine, project, status, title, whether each needs you, and its workspace: kind, and each repository's branch and pull requests. `byRepository` lists this page's members by remote, else `<environmentId>:<repositoryPath>`. Members with none are absent. A workspace is `omitted` when its machine's answer reached 48 KB of workspace JSON, and `tooLarge` when it alone is over that or a page. Call again in seconds for one `pending`, `omitted` or `stale`. Page with `cursor`, 30 KB at most.",
    parameters: Schema.Struct({
      cursor: Schema.optional(NonNegativeInt),
      limit: Schema.optional(clampedPositiveInt(100)),
    }),
    success: Schema.Struct({
      missionId: Schema.String,
      name: Schema.String,
      members: Schema.Array(
        Schema.Struct({
          /** The names the mission status and wakes use, as "member 3" on "machine 2". */
          member: Schema.String,
          place: Schema.String,
          threadRef: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
          machine: Schema.String,
          project: Schema.String,
          status: Schema.Union([MemberStatus, Schema.Literal("offline")]),
          title: Schema.String,
          needsAttention: Schema.Boolean,
          /** `unknown`: its machine has not said, under the member's current claim. */
          workspace: Schema.Union([ListedWorkspace, Schema.Literal("unknown")]),
        }),
      ),
      byRepository: Schema.Array(
        Schema.Struct({
          repository: Schema.String,
          members: Schema.Array(Schema.Struct({ member: Schema.String, place: Schema.String })),
        }),
      ),
      total: NonNegativeInt,
      nextCursor: Schema.NullOr(NonNegativeInt),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: leadOnly,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("t3_mission_add", {
    description:
      "Add a thread to the mission you lead. A thread on a linked machine needs a full-access link. `pending`: its machine has not answered yet.",
    parameters: Schema.Struct({ threadRef: MissionThreadRef }),
    success: Schema.Struct({
      state: Schema.Literals(["joined", "pending"]),
      next: Schema.optional(Schema.String),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: leadOnly,
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("t3_mission_release", {
    description:
      "Make a thread leave the mission you lead. It stays a thread. `pending`: its machine has not answered yet.",
    parameters: Schema.Struct({ threadRef: MissionThreadRef }),
    success: Schema.Struct({ state: Schema.Literals(["released", "pending"]) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: leadOnly,
  })
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
