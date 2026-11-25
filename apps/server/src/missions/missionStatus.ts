import type {
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { secretRequestAsPendingInput } from "../orchestration-v2/ProjectionStore.ts";
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

/**
 * A member's own machine sends this with each claim it lists, so its lead can show it. `run` and
 * `requests` name what the lead is woken for, so a turn or a request between two lists is seen.
 */
export const MemberDetail = Schema.Struct({
  status: MemberStatus,
  title: Schema.String,
  project: Schema.String,
  /** The latest run and its status. Absent from machines that predate it. */
  run: Schema.optional(Schema.Struct({ id: Schema.String, status: Schema.String })),
  /** The requests and input cards it waits on. Absent from machines that predate it. */
  requests: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })),
  ),
});
export type MemberDetail = typeof MemberDetail.Type;

/** What wakes a lead: a member that needs it, or one that finished a turn. */
export type MissionUpdateEvent = "awaiting-input" | "pending-approval" | "failed" | "completed";

export interface RosterMember {
  readonly ref: ScopedThreadRef;
  /** "this machine", or the member machine's environment id: never a name anyone typed. */
  readonly place: string;
  /** Names, for the roster tool's data only. */
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

/** A request or input card the member waits on, as its thread shows it. */
const waitedOn = (shell: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">) => {
  const request = shell.pendingRuntimeRequest;
  // A question the run keeps working past, or T3's own tool call, needs no one.
  return request !== null && request.blocking !== false && request.kind !== "dynamic_tool_call"
    ? request
    : null;
};

const eventForRequest = (kind: string) =>
  INPUT_REQUESTS.has(kind) ? ("awaiting-input" as const) : ("pending-approval" as const);

export const memberStatusOf = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "status" | "pendingRuntimeRequest" | "hasActionableProposedPlan"
  >,
): MemberStatus => {
  const request = waitedOn(shell);
  if (request !== null) return eventForRequest(request.kind);
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

/** One thing a lead is told about: `source` names the run, request or card it came from. */
export interface SourcedUpdate {
  readonly source: string;
  readonly event: MissionUpdateEvent;
}

/**
 * What a member's own event says it needs: a request it waits on, an input card such as a secret
 * request, or a turn that ended. Events of the same source may be written again.
 */
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
    // The projection's own test for a card that blocks on the user.
    const card =
      event.payload.status === "waiting" ? secretRequestAsPendingInput(event.payload) : null;
    return card === null ? undefined : { source: `request:${card.id}`, event: "awaiting-input" };
  }
  const request = event.payload;
  if (request.status !== "pending" || request.kind === "dynamic_tool_call") return undefined;
  return { source: `request:${request.id}`, event: eventForRequest(request.kind) };
};

/** What the lead keeps of a remote member between lists, and across a restart. */
interface Mark {
  readonly status: MemberStatus;
  readonly run?: { readonly id: string; readonly status: string } | undefined;
  readonly requests?: ReadonlyArray<string> | undefined;
}

export const markOf = (detail: MemberDetail): string =>
  JSON.stringify({
    status: detail.status,
    run: detail.run,
    requests: detail.requests?.map((request) => request.id),
  } satisfies Mark);

/**
 * What a remote member's list says since its mark: a run that ended, by its id, and each request
 * not seen before, by its id. A machine that predates them is compared by status, each change its
 * own source. The first list of a member only leaves its mark.
 */
export const remoteUpdates = (
  before: string | undefined,
  detail: MemberDetail,
  listedAt: number,
): ReadonlyArray<SourcedUpdate> => {
  if (before === undefined) return [];
  const mark = JSON.parse(before) as Mark;
  if (detail.run === undefined && detail.requests === undefined) {
    const event = updateFor(mark.status, detail.status);
    return event === undefined ? [] : [{ source: `status:${event}:${listedAt}`, event }];
  }
  const updates: Array<SourcedUpdate> = [];
  const run = detail.run;
  if (
    run !== undefined &&
    (run.status === "completed" || run.status === "failed") &&
    (mark.run?.id !== run.id || mark.run.status !== run.status)
  ) {
    updates.push({
      source: `run:${run.id}`,
      event: run.status === "completed" ? "completed" : "failed",
    });
  }
  for (const request of detail.requests ?? []) {
    if (mark.requests?.includes(request.id) === true) continue;
    updates.push({ source: `request:${request.id}`, event: eventForRequest(request.kind) });
  }
  return updates;
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
  const request = waitedOn(shell);
  return {
    status: memberStatusOf(shell),
    title: shell.title,
    project,
    ...(shell.latestRunId === null ? {} : { run: { id: shell.latestRunId, status: shell.status } }),
    requests: request === null ? [] : [{ id: request.id, kind: request.kind }],
  } satisfies MemberDetail;
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

/**
 * The header, then the user's prompt, which acts as instructions. The header names the Mission by
 * its id only: its name is the lead's title, which any agent allowed to rename threads can set.
 */
export const missionPromptText = (missionId: string, prompt: string) => {
  const header = `You lead a mission (id ${missionId}). You orchestrate its threads. If the user asks for something different in a message, the message wins.`;
  const text = prompt === "" ? header : `${header}\n\n${prompt}`;
  if (bytes(text) <= MISSION_PROMPT_MAX_BYTES) return text;
  return `${cutToBytes(text, MISSION_PROMPT_MAX_BYTES - bytes(PROMPT_CUT_NOTE))}${PROMPT_CUT_NOTE}`;
};

/** Ids come from other machines too, so one is cut to a single short line. */
const oneLine = (text: string) => {
  const flat = [...text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim()];
  return flat.length <= 80 ? flat.join("") : `${flat.slice(0, 80).join("")}…`;
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
 * Names only ids and statuses, never a title or label anyone can edit, and no times, so it changes
 * only when a member's status does. Names are in the roster tool's result, as data.
 */
export const missionStatusText = (members: ReadonlyArray<RosterMember>) => {
  const count = (statuses: ReadonlyArray<RosterStatus>) =>
    members.filter((member) => statuses.includes(member.status)).length;
  const head = `Status: ${members.length} ${members.length === 1 ? "member" : "members"}. ${count(["awaiting-input", "pending-approval"])} need you (awaiting input, pending approval), ${count(["failed"])} failed, ${count(["working"])} working, ${count(["idle"])} idle, ${count(["offline"])} offline.`;
  const attention = members
    .filter((member) => needsAttention(member.status))
    .map(
      (member) =>
        `Needs attention: ${oneLine(member.ref.threadId)} on ${oneLine(member.place)}, ${STATUS_LABELS[member.status]}.`,
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

/** Names each member by id and place only, as the status does. */
export const missionUpdateText = (
  updates: ReadonlyArray<{
    readonly ref: ScopedThreadRef;
    readonly place: string;
    readonly event: MissionUpdateEvent;
  }>,
) => {
  const lines = updates.map(
    (update) =>
      `thread ${oneLine(update.ref.threadId)} on ${oneLine(update.place)} ${UPDATE_TEXT[update.event]}.`,
  );
  const more = lines.length - ATTENTION_LINES;
  const body =
    lines.length === 1
      ? `Mission update: ${lines[0]}`
      : [
          "Mission update:",
          ...lines.slice(0, ATTENTION_LINES).map((line) => `- ${line}`),
          ...(more > 0 ? [`… and ${more} more`] : []),
        ].join("\n");
  return `${body}\nFor details, call t3_thread_read or t3_mission_roster.`;
};

/** The place a status or wake names a member by. */
export const placeOf = (environmentId: string, here: string) =>
  environmentId === here ? "this machine" : environmentId;
