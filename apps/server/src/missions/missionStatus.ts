import type {
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";

/** What a member is doing, as its own machine reads it. */
export const MemberStatus = Schema.Literals([
  "awaiting-input",
  "pending-approval",
  "failed",
  "working",
  "idle",
]);
export type MemberStatus = typeof MemberStatus.Type;
/** `offline`: its machine does not answer, or has not said yet. */
export type RosterStatus = MemberStatus | "offline";

/** A member's own machine sends this with each claim it lists, so its lead can show it. */
export const MemberDetail = Schema.Struct({
  status: MemberStatus,
  title: Schema.String,
  project: Schema.String,
});
export type MemberDetail = typeof MemberDetail.Type;

/** What wakes a lead: a member that needs it, or one that finished a turn. */
export type MissionUpdateEvent = "awaiting-input" | "pending-approval" | "failed" | "completed";

export interface RosterMember {
  readonly ref: ScopedThreadRef;
  readonly machine: string;
  readonly project: string;
  readonly status: RosterStatus;
  readonly title: string;
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

export const memberStatusOf = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "status" | "pendingRuntimeRequest" | "hasActionableProposedPlan"
  >,
): MemberStatus => {
  const request = shell.pendingRuntimeRequest;
  // A question the run keeps working past, or T3's own tool call, needs no one.
  if (request !== null && request.blocking !== false && request.kind !== "dynamic_tool_call") {
    return INPUT_REQUESTS.has(request.kind) ? "awaiting-input" : "pending-approval";
  }
  if (shell.status === "failed") return "failed";
  if (WORKING.has(shell.status)) return "working";
  return shell.hasActionableProposedPlan ? "awaiting-input" : "idle";
};

export const needsAttention = (status: RosterStatus) =>
  status === "awaiting-input" || status === "pending-approval" || status === "failed";

/** Only a move into a state that needs the lead wakes it, so a member starting work never does. */
export const updateFor = (
  before: MemberStatus | undefined,
  after: MemberStatus,
): MissionUpdateEvent | undefined => {
  if (before === undefined || before === after || after === "working") return undefined;
  if (after === "idle") return before === "working" ? "completed" : undefined;
  return after;
};

/**
 * What a member's own event says it needs: a request it waits on, or a turn that ended. `key`
 * names the request or the run's ending, which may be written again.
 */
export const updateFromEvent = (
  event:
    | { readonly type: "run.updated"; readonly payload: Pick<OrchestrationV2Run, "id" | "status"> }
    | {
        readonly type: "runtime-request.updated";
        readonly payload: Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status">;
      },
): { readonly key: string; readonly event: MissionUpdateEvent } | undefined => {
  const { payload } = event;
  if (event.type === "run.updated") {
    const ended =
      payload.status === "completed"
        ? "completed"
        : payload.status === "failed"
          ? "failed"
          : undefined;
    return ended === undefined ? undefined : { key: `run:${payload.id}`, event: ended };
  }
  const request = event.payload;
  if (request.status !== "pending" || request.kind === "dynamic_tool_call") return undefined;
  return {
    key: `request:${request.id}`,
    event: INPUT_REQUESTS.has(request.kind) ? "awaiting-input" : "pending-approval",
  };
};

/** A thread here, as its lead sees it. Undefined when it is gone or cannot be read. */
export const memberDetail = Effect.fn("missionStatus.memberDetail")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) return undefined;
  const project = yield* projects.getShell(shell.projectId).pipe(
    Effect.map(Option.match({ onNone: () => "", onSome: (found) => found.title })),
    Effect.orElseSucceed(() => ""),
  );
  return { status: memberStatusOf(shell), title: shell.title, project } satisfies MemberDetail;
});

/** Codex cuts each context entry past about 1,000 tokens, counted as 4 bytes each. */
export const MISSION_PROMPT_MAX_BYTES = 4_000;
export const MISSION_STATUS_MAX_BYTES = 1_500;
const ATTENTION_LINES = 10;
const PROMPT_CUT_NOTE = "\n\n[The mission prompt was cut here to fit 4,000 bytes.]";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Whole code points only, so a cut never splits a character. */
const cutToBytes = (text: string, max: number) => {
  let kept = "";
  let size = 0;
  for (const codePoint of text) {
    size += bytes(codePoint);
    if (size > max) break;
    kept += codePoint;
  }
  return kept;
};

/** The header, then the user's prompt, which acts as instructions. */
export const missionPromptText = (name: string, prompt: string) => {
  const header = `You are the lead of the mission "${name}". You orchestrate its threads. If the user asks for something different in a message, the message wins.`;
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

/**
 * Written only from what the app knows, never from a title an agent wrote, and with no times,
 * so it changes only when a member's status does.
 */
export const missionStatusText = (members: ReadonlyArray<RosterMember>) => {
  const count = (statuses: ReadonlyArray<RosterStatus>) =>
    members.filter((member) => statuses.includes(member.status)).length;
  const head = `Status: ${members.length} ${members.length === 1 ? "member" : "members"}. ${count(["awaiting-input", "pending-approval"])} need you (awaiting input, pending approval), ${count(["failed"])} failed, ${count(["working"])} working, ${count(["idle"])} idle, ${count(["offline"])} offline.`;
  const attention = members
    .filter((member) => needsAttention(member.status))
    .map(
      (member) =>
        `Needs attention: ${member.ref.threadId} on ${member.machine} (${member.project}), ${STATUS_LABELS[member.status]}.`,
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
};

/** Names each member by id and place only: the lead reads the rest with its tools. */
export const missionUpdateText = (
  updates: ReadonlyArray<{
    readonly ref: ScopedThreadRef;
    readonly machine: string;
    readonly project: string;
    readonly event: MissionUpdateEvent;
  }>,
) => {
  const lines = updates.map(
    (update) =>
      `thread ${update.ref.threadId} on ${update.machine} (${update.project}) ${UPDATE_TEXT[update.event]}.`,
  );
  const body =
    lines.length === 1
      ? `Mission update: ${lines[0]}`
      : ["Mission update:", ...lines.map((line) => `- ${line}`)].join("\n");
  return `${body}\nFor details, call t3_thread_read or t3_mission_roster.`;
};
