import type {
  ListedWorkspace,
  MemberDetail,
  MemberStatus,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { secretRequestAsPendingInput } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import { MemberWorkspaces } from "./MemberWorkspaces.ts";

export type RosterStatus = MemberStatus | "offline";

export type MissionUpdateEvent =
  | "awaiting-input"
  | "pending-approval"
  | "failed"
  | "completed"
  | "joined";

export interface RosterMember {
  readonly ref: ScopedThreadRef;
  readonly member: string;
  readonly place: string;
  readonly machine: string;
  readonly project: string;
  readonly status: RosterStatus;
  readonly title: string;
  readonly workspace?: ListedWorkspace | undefined;
}

const WORKING: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const INPUT_REQUESTS: ReadonlySet<string> = new Set([
  "user_input",
  "mcp-elicitation",
  "auth_refresh",
]);

const waitedOn = (shell: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">) => {
  const request = shell.pendingRuntimeRequest;
  return request !== null && request.blocking !== false && request.kind !== "dynamic_tool_call"
    ? request
    : null;
};

const eventForRequest = (kind: string) =>
  INPUT_REQUESTS.has(kind) ? ("awaiting-input" as const) : ("pending-approval" as const);

type StatusFields = Pick<
  OrchestrationV2ThreadShell,
  "status" | "pendingRuntimeRequest" | "hasActionableProposedPlan" | "pendingBackgroundTasks"
>;

export const memberStatusOf = (shell: StatusFields): MemberStatus => {
  const request = waitedOn(shell);
  if (request !== null) return eventForRequest(request.kind);
  if (shell.status === "failed") return "failed";
  if (
    WORKING.has(shell.status) ||
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])
  )
    return "working";
  return shell.hasActionableProposedPlan ? "awaiting-input" : "idle";
};

export const needsAttention = (status: RosterStatus) =>
  status === "awaiting-input" || status === "pending-approval" || status === "failed";

export const updateFor = (
  before: MemberStatus | undefined,
  after: MemberStatus,
): MissionUpdateEvent | undefined => {
  if (before === undefined || before === after || after === "working") return undefined;
  if (after === "idle") return before === "working" ? "completed" : undefined;
  return after;
};

export interface SourcedUpdate {
  readonly source: string;
  readonly event: MissionUpdateEvent;
}

export const updateFromEvent = (
  event:
    | { readonly type: "run.updated"; readonly payload: Pick<OrchestrationV2Run, "id" | "status"> }
    | {
        readonly type: "runtime-request.updated";
        readonly payload: Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status">;
      }
    | { readonly type: "turn-item.updated"; readonly payload: OrchestrationV2TurnItem },
): SourcedUpdate | undefined => {
  if (event.type === "run.updated") {
    const { status, id } = event.payload;
    return status === "completed" || status === "failed"
      ? { source: `run:${id}`, event: status === "completed" ? "completed" : "failed" }
      : undefined;
  }
  if (event.type === "turn-item.updated") {
    const card =
      event.payload.status === "waiting" ? secretRequestAsPendingInput(event.payload) : null;
    return card === null ? undefined : { source: `request:${card.id}`, event: "awaiting-input" };
  }
  const request = event.payload;
  if (request.status !== "pending" || request.kind === "dynamic_tool_call") return undefined;
  return { source: `request:${request.id}`, event: eventForRequest(request.kind) };
};

interface Mark {
  readonly status: MemberStatus;
  readonly run?: { readonly id: string; readonly status: string } | undefined;
  readonly held?: boolean | undefined;
  readonly requests?: ReadonlyArray<string> | undefined;
  readonly unreportedCompletionRunId?: string | undefined;
}

const isHeld = (seen: Partial<Pick<Mark, "status" | "held">>) =>
  seen.held ?? seen.status === "working";

const markFields = (detail: MemberDetail): Mark => ({
  status: detail.status,
  run: detail.run,
  held: detail.held,
  requests: detail.requests?.map((request) => request.id),
});

export const markOf = (detail: MemberDetail): string => JSON.stringify(markFields(detail));

export const wasCompletionHeld = (mark: string) =>
  (JSON.parse(mark) as Partial<Mark>).unreportedCompletionRunId !== undefined;

/** Older peers send status without run or request IDs. Compare their statuses instead. */
export const memberUpdates = (
  before: string | undefined,
  detail: MemberDetail,
  listedAt: number,
): { readonly updates: ReadonlyArray<SourcedUpdate>; readonly mark: string } => {
  const unchanged = (updates: ReadonlyArray<SourcedUpdate>) => ({ updates, mark: markOf(detail) });
  if (before === undefined && !needsAttention(detail.status)) return unchanged([]);
  const mark: Partial<Mark> = before === undefined ? {} : (JSON.parse(before) as Mark);
  if (detail.run === undefined && detail.requests === undefined) {
    const event =
      before === undefined
        ? (detail.status as MissionUpdateEvent)
        : updateFor(mark.status, detail.status);
    return unchanged(event === undefined ? [] : [{ source: `status:${event}:${listedAt}`, event }]);
  }
  const updates: Array<SourcedUpdate> = [];
  const told = (id: string, event: "completed" | "failed") =>
    updates.push({ source: `run:${id}`, event });
  let unreportedCompletionRunId = mark.unreportedCompletionRunId;
  const run = detail.run;
  const fresh = run !== undefined && (mark.run?.id !== run.id || mark.run.status !== run.status);
  if (run?.status === "failed") {
    if (fresh) told(run.id, "failed");
    unreportedCompletionRunId = undefined;
  } else if (run?.status === "completed" && isHeld(detail)) {
    unreportedCompletionRunId = run.id;
  } else if (run?.status === "completed") {
    if (fresh || unreportedCompletionRunId === run.id) told(run.id, "completed");
    unreportedCompletionRunId = undefined;
  } else if (
    unreportedCompletionRunId !== undefined &&
    !isHeld(detail) &&
    !WORKING.has(run?.status ?? "")
  ) {
    told(unreportedCompletionRunId, "completed");
    unreportedCompletionRunId = undefined;
  }
  for (const request of detail.requests ?? []) {
    if (mark.requests?.includes(request.id) === true) continue;
    updates.push({ source: `request:${request.id}`, event: eventForRequest(request.kind) });
  }
  return {
    updates,
    mark: JSON.stringify({ ...markFields(detail), unreportedCompletionRunId } satisfies Mark),
  };
};

export const shellDetail = (
  shell: StatusFields & Pick<OrchestrationV2ThreadShell, "latestRunId">,
): MemberDetail => {
  const request = waitedOn(shell);
  return {
    status: memberStatusOf(shell),
    title: "",
    project: "",
    ...(shell.latestRunId === null ? {} : { run: { id: shell.latestRunId, status: shell.status } }),
    held: backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []),
    requests: request === null ? [] : [{ id: request.id, kind: request.kind }],
  };
};

export const memberDetail = Effect.fn("missionStatus.memberDetail")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const workspaces = yield* MemberWorkspaces;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) return undefined;
  const project = yield* projects.getShell(shell.projectId).pipe(
    Effect.map(Option.match({ onNone: () => "", onSome: (found) => found.title })),
    Effect.orElseSucceed(() => ""),
  );
  return {
    ...shellDetail(shell),
    title: shell.title,
    project,
    workspace: yield* workspaces.cached(shell),
  } satisfies MemberDetail;
});

/** Codex cuts each context entry past about 1,000 tokens, counted as 4 bytes each. */
export const MISSION_PROMPT_MAX_BYTES = 4_000;
export const MISSION_STATUS_MAX_BYTES = 1_500;
export const ATTENTION_LINES = 10;
const PROMPT_CUT_NOTE = "\n\n[The mission prompt was cut here to fit 4,000 bytes.]";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export const LISTED_WORKSPACE_MAX_BYTES = 48_000;
export const FOLLOW_UPS_PER_SWEEP = 2;

export const withinWorkspaceRoom = <
  Listed extends { readonly threadId: ThreadId; readonly detail?: MemberDetail | undefined },
>(
  listed: ReadonlyArray<Listed>,
): ReadonlyArray<Listed> => {
  let room = LISTED_WORKSPACE_MAX_BYTES;
  return listed.map((claim) => {
    const workspace = claim.detail?.workspace;
    if (workspace === undefined || typeof workspace === "string") return claim;
    const size = bytes(JSON.stringify(workspace));
    if (size > LISTED_WORKSPACE_MAX_BYTES) {
      return { ...claim, detail: { ...claim.detail!, workspace: "tooLarge" } };
    }
    if (size > room) return { ...claim, detail: { ...claim.detail!, workspace: "omitted" } };
    room -= size;
    return claim;
  });
};

export const cutToBytes = (text: string, max: number) => {
  let kept = "";
  let size = 0;
  for (const codePoint of text) {
    size += bytes(codePoint);
    if (size > max) break;
    kept += codePoint;
  }
  return kept;
};

const MISSION_LEAD_GUIDANCE = [
  "The mission has no branch or checkout of its own: each repository's work is done in its members' threads.",
  "- Changes to several repositories that must land together: one member, in a multi-repository project.",
  '- Separable changes: a member each with t3_thread_launch. For code edits, pass `environmentId` and `projectId` at the top level, and `workspaceStrategy: { type: "worktree", baseRef, repositories: [{ path }] }`. `repositories` lists tracked extra repositories, not the project root.',
  "- Use create_threads only for members that should share your checkout.",
  "- Drive each repository to a pull request. Track which repositories need changes, need none, or are blocked; t3_mission_roster lists them by repository.",
  "- Never pull, push, merge or switch branches only because a thread joined or finished.",
  "- When a member joins with prior work, get its brief before giving it new work.",
  "- If an update needs nothing from the user and changes no milestone, end your turn with no reply text. Milestones are a pull request opened, merged or live, a member blocked or failed, and a question for the user.",
  "- Make every question to the user stand on its own. Link the member thread. Say in plain words what it is working on, what must be decided and why now, and what each option changes. Recommend one option. Do not rely on earlier messages.",
];

export const missionPromptText = (missionId: string, prompt: string) => {
  const header = [
    `You lead a mission (id ${missionId}). You orchestrate its threads. If the user asks for something different in a message, the message wins.`,
    ...MISSION_LEAD_GUIDANCE,
  ].join("\n");
  const text = prompt === "" ? header : `${header}\n\n${prompt}`;
  if (bytes(text) <= MISSION_PROMPT_MAX_BYTES) return text;
  return `${cutToBytes(text, MISSION_PROMPT_MAX_BYTES - bytes(PROMPT_CUT_NOTE))}${PROMPT_CUT_NOTE}`;
};

const STATUS_LABELS: Record<RosterStatus, string> = {
  "awaiting-input": "awaiting input",
  "pending-approval": "pending approval",
  failed: "failed",
  working: "working",
  idle: "idle",
  offline: "offline",
};

export const missionStatusText = (members: ReadonlyArray<RosterMember>) => {
  const count = (statuses: ReadonlyArray<RosterStatus>) =>
    members.filter((member) => statuses.includes(member.status)).length;
  const head = `Status: ${members.length} ${members.length === 1 ? "member" : "members"}. ${count(["awaiting-input", "pending-approval"])} need you (awaiting input, pending approval), ${count(["failed"])} failed, ${count(["working"])} working, ${count(["idle"])} idle, ${count(["offline"])} offline.`;
  const attention = members
    .filter((member) => needsAttention(member.status))
    .map(
      (member) =>
        `Needs attention: ${member.member} on ${member.place}, ${STATUS_LABELS[member.status]}.`,
    );
  const build = (shown: number) => {
    const more = attention.length - shown;
    return [
      head,
      ...attention.slice(0, shown),
      ...(more > 0 ? [`… and ${more} more`] : []),
      "For titles and the full list, call t3_mission_roster.",
    ].join("\n");
  };
  let shown = Math.min(attention.length, ATTENTION_LINES);
  while (shown > 0 && bytes(build(shown)) > MISSION_STATUS_MAX_BYTES) shown -= 1;
  return build(shown);
};

const UPDATE_TEXT: Record<MissionUpdateEvent, string> = {
  "awaiting-input": "is awaiting input",
  "pending-approval": "has a pending approval",
  failed: "failed",
  completed: "finished its turn and is idle",
  joined: "joined with prior work",
};

export const GET_THE_BRIEF =
  'Get its brief before giving it new work: queue a message asking for it with t3_thread_send (mode "queue", outputSchema a JSON Schema object with additionalProperties false whose required "brief" property is a string with maxLength 4000), then call t3_thread_wait with the runId it returned and untilOutput: true. If the send is refused or the member is settled, read it with t3_thread_read (limit: 2, runLimit: 1, maxCharsPerItem: 4000) instead.';

export const missionUpdateText = (
  updates: ReadonlyArray<{
    readonly member: string;
    readonly place: string;
    readonly event: MissionUpdateEvent;
    readonly status?: string | undefined;
  }>,
) => {
  const lines = updates.map(
    (update) =>
      `${update.member} on ${update.place} ${UPDATE_TEXT[update.event]}${
        update.event === "joined" ? ` (status: ${update.status ?? "unknown"})` : ""
      }.`,
  );
  const briefing = updates.slice(0, ATTENTION_LINES).some((update) => update.event === "joined");
  const more = lines.length - ATTENTION_LINES;
  const body =
    lines.length === 1
      ? `Mission update: ${lines[0]}`
      : [
          "Mission update:",
          ...lines.slice(0, ATTENTION_LINES).map((line) => `- ${line}`),
          ...(more > 0 ? [`… and ${more} more`] : []),
        ].join("\n");
  return `${body}\n${briefing ? `${GET_THE_BRIEF}\n` : ""}For details, call t3_thread_read (limit: 2, runLimit: 1) or t3_mission_roster.`;
};
