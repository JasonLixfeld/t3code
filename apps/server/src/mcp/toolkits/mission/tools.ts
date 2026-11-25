import {
  clampedPositiveInt,
  EnvironmentId,
  MissionId,
  MissionName,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ListedWorkspace, MemberWorkspaces } from "../../../missions/MemberWorkspaces.ts";
import { MissionClaimKind, MissionClaims } from "../../../missions/MissionClaims.ts";
import {
  MemberDetail,
  MemberStatus,
  WORKSPACES_PER_CALL,
} from "../../../missions/missionStatus.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only to a linked environment's session: agents never see or call it. */
const shownOnlyToLinks = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.client?.linked === true;
};

/**
 * `join` needs threadId, missionId and name; `release` threadId, missionId and generation;
 * `rename` missionId and name; `workspaces` members. A join may name its add with intentId. It
 * answers with no claim when that add's claim was dropped.
 */
const MissionTagInput = Schema.Struct({
  /** `brief`: the lead asks a member here to brief it, the app's request, sent once. */
  kind: Schema.Union([MissionClaimKind, Schema.Literal("brief")]),
  askedAt: Schema.optional(Schema.Number),
  threadId: Schema.optional(ThreadId),
  missionId: Schema.optional(MissionId),
  name: Schema.optional(MissionName),
  generation: Schema.optional(Schema.String),
  intentId: Schema.optional(Schema.String),
  /** The caller's claims whose workspaces a list left out. */
  members: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: ThreadId, generation: Schema.String })).check(
      Schema.isMaxLength(WORKSPACES_PER_CALL),
    ),
  ),
});

export const MissionClaimResult = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      missionId: Schema.String,
      name: Schema.String,
      role: Schema.Literals(["lead", "member"]),
      generation: Schema.String,
      /** Absent from machines that predate it. */
      detail: Schema.optional(MemberDetail),
    }),
  ),
  /** What became of a `brief` request. Absent from machines that predate it. */
  brief: Schema.optional(Schema.Literals(["asked", "empty", "parked"])),
});

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
      Project.ProjectService,
      MemberWorkspaces,
      MissionClaims,
    ],
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, shownOnlyToLinks),
  Tool.make("t3_mission_roster", {
    description:
      "List the member threads of the mission you lead: machine, project, status, title, whether each needs you, and its workspace: kind, and each repository's branch and pull requests. `byRepository` groups this page's repository entries by remote, else `<environmentId>:<repositoryPath>`. Members with none are absent. A workspace is `omitted` when its machine's answer reached 48 KB of workspace JSON, and `tooLarge` when it alone is over that. Call again in a few seconds for one that is `pending`, `omitted` or `stale`. Page with `cursor`.",
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
          members: Schema.Array(
            Schema.Struct({
              member: Schema.String,
              place: Schema.String,
              branch: Schema.NullOr(Schema.String),
              branchSource: Schema.Literals(["live", "recorded"]),
              pullRequests: Schema.Array(
                Schema.Struct({ number: Schema.Number, state: Schema.String, url: Schema.String }),
              ),
            }),
          ),
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
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessMissionLead),
  Tool.make("t3_mission_add", {
    description:
      "Add a thread to the mission you lead. A thread on a linked machine needs a full-access link. `pending`: its machine has not answered yet.",
    parameters: Schema.Struct({ threadRef: MissionThreadRef }),
    success: Schema.Struct({ state: Schema.Literals(["joined", "pending"]) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: leadOnly,
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessMissionLead),
  Tool.make("t3_mission_release", {
    description:
      "Release a thread from the mission you lead. It stays a thread. `pending`: its machine has not answered yet.",
    parameters: Schema.Struct({ threadRef: MissionThreadRef }),
    success: Schema.Struct({ state: Schema.Literals(["released", "pending"]) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: leadOnly,
  })
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessMissionLead),
);
