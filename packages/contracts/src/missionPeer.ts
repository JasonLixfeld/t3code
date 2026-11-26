import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { MissionId, MissionName } from "./mission.ts";
import { PullRequestState } from "./pullRequest.ts";

export const MISSION_WORKSPACES_PER_CALL = 8;

const MemberPullRequest = Schema.Struct({
  number: Schema.Number,
  state: Schema.Union([PullRequestState, Schema.Literal("unknown")]),
  url: Schema.String,
});

export const MemberRepository = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  repositoryPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  branchSource: Schema.Literals(["live", "recorded"]),
  remote: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(MemberPullRequest),
});
export type MemberRepository = typeof MemberRepository.Type;

export const MemberWorkspace = Schema.Struct({
  kind: Schema.Literals(["project", "worktree", "task-folder"]),
  repositories: Schema.Array(MemberRepository),
  truncated: Schema.Boolean,
  otherPullRequests: Schema.Array(
    Schema.Struct({ ...MemberPullRequest.fields, repository: Schema.String }),
  ),
  stale: Schema.Boolean,
});
export type MemberWorkspace = typeof MemberWorkspace.Type;

export const ListedWorkspace = Schema.Union([
  MemberWorkspace,
  Schema.Literals(["pending", "omitted", "tooLarge"]),
]);
export type ListedWorkspace = typeof ListedWorkspace.Type;

export const MemberStatus = Schema.Literals([
  "awaiting-input",
  "pending-approval",
  "failed",
  "working",
  "idle",
]);
export type MemberStatus = typeof MemberStatus.Type;

export const MemberDetail = Schema.Struct({
  status: MemberStatus,
  title: Schema.String,
  project: Schema.String,
  run: Schema.optional(Schema.Struct({ id: Schema.String, status: Schema.String })),
  /** Background work the member started still holds its finished turn. */
  held: Schema.optional(Schema.Boolean),
  requests: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })),
  ),
  workspace: Schema.optional(ListedWorkspace),
});
export type MemberDetail = typeof MemberDetail.Type;

const MissionClaimKind = Schema.Literals(["join", "release", "list", "rename", "workspaces"]);

export const MissionTagInput = Schema.Struct({
  kind: MissionClaimKind,
  threadId: Schema.optional(ThreadId),
  missionId: Schema.optional(MissionId),
  name: Schema.optional(MissionName),
  generation: Schema.optional(Schema.String),
  intentId: Schema.optional(Schema.String),
  members: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: ThreadId, generation: Schema.String })).check(
      Schema.isMaxLength(MISSION_WORKSPACES_PER_CALL),
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
      detail: Schema.optional(MemberDetail),
    }),
  ),
});
