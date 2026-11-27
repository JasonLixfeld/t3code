import {
  type ContextMenuItem,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type Mission,
  type MissionMember,
  type MissionsSnapshot,
  isSettledMissionMember,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  MISSION_QUIET_REPLY,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
  threadHasMessages,
} from "@t3tools/contracts";
import { resolveT3McpToolId, T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { scopedThreadKey, scopeThreadRef } from "./environment/scoped.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * The key `missionsLiveAcross` reads: each connected server this session may read, once its
 * config is known, and whether it can omit prompts from the list.
 */
export function missionsLiveKey(input: {
  readonly enabled: boolean;
  readonly connected: ReadonlyArray<EnvironmentId>;
  readonly readable: ReadonlySet<EnvironmentId>;
  readonly descriptorOf: (
    environmentId: EnvironmentId,
  ) => Pick<ExecutionEnvironmentDescriptor, "capabilities"> | undefined;
}): string {
  // A fork server from before the capability serves Missions too, with prompts in the list.
  const asked = input.enabled
    ? input.connected.flatMap((environmentId) => {
        const descriptor = input.descriptorOf(environmentId);
        return input.readable.has(environmentId) && descriptor !== undefined
          ? [[environmentId, descriptor.capabilities.missions === true] as const]
          : [];
      })
    : [];
  return JSON.stringify(asked);
}

export interface MissionHost {
  readonly environmentId: EnvironmentId;
  readonly snapshot: MissionsSnapshot;
}

export interface MissionCandidate {
  readonly environmentId: EnvironmentId;
  readonly id?: ThreadId;
  readonly latestUserMessageAt: string | null;
  readonly visibleItemCount: number;
}

type MissionThread = Pick<MissionCandidate, "environmentId" | "id">;

export type MissionMenuId =
  | "mission-start"
  | `mission-leave:${string}`
  | "mission-add"
  | `mission-add:${string}`
  | `mission-release:${string}`
  | `mission-new-thread:${string}`
  | `mission-delete:${string}`
  | `mission-prompt:${string}`
  | "mission-group"
  | "mission-new-lead"
  | "mission-choose-lead";

export const isMissionMenuId = (id: string): id is MissionMenuId => id.startsWith("mission-");

const ADD_PREFIX = "mission-add:";
const RELEASE_PREFIX = "mission-release:";
const LEAVE_PREFIX = "mission-leave:";
const NEW_THREAD_PREFIX = "mission-new-thread:";
const DELETE_PREFIX = "mission-delete:";
const PROMPT_PREFIX = "mission-prompt:";

export const isThreadMissionAction = (id: MissionMenuId) =>
  id === "mission-start" ||
  id === "mission-add" ||
  id.startsWith(LEAVE_PREFIX) ||
  id.startsWith(RELEASE_PREFIX);
const TARGET_ACTIONS = {
  [ADD_PREFIX]: "add",
  [RELEASE_PREFIX]: "release",
  [LEAVE_PREFIX]: "leave",
  [NEW_THREAD_PREFIX]: "new-thread",
  [DELETE_PREFIX]: "delete",
  [PROMPT_PREFIX]: "prompt",
} as const;

export function parseMissionTarget(id: MissionMenuId): {
  readonly action: (typeof TARGET_ACTIONS)[keyof typeof TARGET_ACTIONS];
  readonly environmentId: EnvironmentId;
  readonly missionId: string;
} | null {
  const prefix = (Object.keys(TARGET_ACTIONS) as Array<keyof typeof TARGET_ACTIONS>).find(
    (candidate) => id.startsWith(candidate),
  );
  if (prefix === undefined) return null;
  const rest = id.slice(prefix.length);
  const split = rest.lastIndexOf(":");
  return {
    action: TARGET_ACTIONS[prefix],
    environmentId: rest.slice(0, split) as EnvironmentId,
    missionId: rest.slice(split + 1),
  };
}

export type MissionBlock = "in-mission" | "no-link" | "fenced" | "not-allowed";

export const claimHere = (thread: MissionThread, hosts: ReadonlyArray<MissionHost>) =>
  thread.id === undefined
    ? undefined
    : missionIndex(hosts).claims.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );

export function missionLeaveId(
  thread: MissionThread,
  heldBy:
    | { readonly host: EnvironmentId; readonly mission: Pick<Mission, "missionId"> }
    | undefined,
  hosts: ReadonlyArray<MissionHost>,
  canChangeOn: (environmentId: EnvironmentId) => boolean,
  meant: string | undefined,
): MissionMenuId | null {
  const claim = claimHere(thread, hosts);
  if (
    claim !== undefined &&
    canChangeOn(thread.environmentId) &&
    (meant === undefined || claim.missionId === meant)
  ) {
    return `${LEAVE_PREFIX}${thread.environmentId}:${claim.missionId}`;
  }
  return heldBy !== undefined && canChangeOn(heldBy.host)
    ? `${RELEASE_PREFIX}${heldBy.host}:${heldBy.mission.missionId}`
    : null;
}

export function missionBlock(
  thread: MissionCandidate,
  host: MissionHost,
  hosts: ReadonlyArray<MissionHost>,
): MissionBlock | null {
  if (claimHere(thread, hosts) !== undefined) return "in-mission";
  if (thread.environmentId === host.environmentId || host.snapshot.linksHidden === true)
    return null;
  const link = host.snapshot.links.find((entry) => entry.environmentId === thread.environmentId);
  if (link === undefined) return "no-link";
  return link.fullAccess ? null : "fenced";
}

export function blockLabel(block: MissionBlock, hostLabel: string, resolve: MFunctionType) {
  switch (block) {
    case "in-mission":
      return resolve(msg("In a mission"));
    case "no-link":
      return resolve(msg("No link from {machine}", { machine: hostLabel }));
    case "fenced":
      return resolve(msg("Needs full-access link"));
    case "not-allowed":
      return resolve(msg("Not allowed here"));
  }
}

export function missionRowItems(
  input: {
    readonly host: EnvironmentId;
    readonly mission: Mission;
    readonly leadGone: boolean;
    readonly canChange: boolean;
  },
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ContextMenuItem<MissionMenuId>> {
  const target = `${input.host}:${input.mission.missionId}`;
  const membersBlockingEnd = input.mission.members.filter(
    (member) =>
      member.role === "member" &&
      member.state !== "add-refused" &&
      !(
        member.state === "active" &&
        member.settled === true &&
        member.ref.environmentId === input.host
      ),
  );
  const blockedHere = membersBlockingEnd.some((member) => member.ref.environmentId === input.host);
  return [
    { id: "mission-group", label: resolve(msg("Mission")), header: true, separatorBefore: true },
    {
      id: `${NEW_THREAD_PREFIX}${target}`,
      label: resolve(msg("New thread in this mission")),
      icon: "message-square-plus",
      disabled: !input.canChange,
      ...(input.canChange ? {} : { detail: blockLabel("not-allowed", "", resolve) }),
    },
    {
      id: `${PROMPT_PREFIX}${target}`,
      label: resolve(msg("Edit mission prompt…")),
      icon: "pencil",
      disabled: !input.canChange,
      ...(input.canChange ? {} : { detail: blockLabel("not-allowed", "", resolve) }),
    },
    ...(input.leadGone
      ? [
          { id: "mission-new-lead" as const, label: resolve(msg("New lead")) },
          { id: "mission-choose-lead" as const, label: resolve(msg("Choose a thread…")) },
        ]
      : []),
    {
      id: `${DELETE_PREFIX}${target}`,
      label: resolve(msg("End mission")),
      icon: "check",
      disabled: membersBlockingEnd.length > 0 || !input.canChange,
      ...(membersBlockingEnd.length > 0
        ? {
            detail: blockedHere
              ? resolve(msg("Has active threads"))
              : resolve(msg("Has threads on another machine")),
          }
        : input.canChange
          ? {}
          : { detail: blockLabel("not-allowed", "", resolve) }),
    },
  ];
}

export function buildMissionMenuItems(
  threads: ReadonlyArray<MissionCandidate>,
  hosts: ReadonlyArray<MissionHost>,
  machineLabel: (environmentId: EnvironmentId) => string,
  canChangeOn: (environmentId: EnvironmentId) => boolean,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ContextMenuItem<MissionMenuId>> {
  const inMission = threads.some((thread) => claimHere(thread, hosts) !== undefined);
  const missions = hosts.flatMap((host) =>
    host.snapshot.missions.map((mission) => ({ host, mission })),
  );
  const single = threads.length === 1 ? threads[0] : undefined;
  const startHost =
    single === undefined
      ? undefined
      : hosts.find((host) => host.environmentId === single.environmentId);
  const holding =
    single?.id === undefined
      ? undefined
      : missionIndex(hosts).holders.get(
          scopedThreadKey(scopeThreadRef(single.environmentId, single.id)),
        );
  const heldBy =
    holding !== undefined && holding.member.role === "member" && isJoined(holding.member)
      ? holding
      : undefined;
  if (holding !== undefined && holding.member.role === "lead") {
    return missionRowItems(
      {
        host: holding.host,
        mission: holding.mission,
        leadGone: false,
        canChange: canChangeOn(holding.host),
      },
      resolve,
    );
  }
  return [
    ...(single === undefined
      ? []
      : [
          {
            id: "mission-start" as const,
            label: resolve(msg("Start mission from this thread")),
            icon: "folder-tree",
            separatorBefore: true,
            disabled: inMission || startHost === undefined || !canChangeOn(single.environmentId),
            ...(inMission
              ? { detail: resolve(msg("In a mission")) }
              : startHost === undefined
                ? { detail: resolve(msg("Not supported here")) }
                : !canChangeOn(single.environmentId)
                  ? { detail: blockLabel("not-allowed", "", resolve) }
                  : {}),
          },
        ]),
    ...(single === undefined || (heldBy === undefined && claimHere(single, hosts) === undefined)
      ? []
      : [missionLeaveId(single, heldBy, hosts, canChangeOn, holding?.mission.missionId)].map(
          (id) => ({
            id: id ?? LEAVE_PREFIX,
            label: resolve(msg("Leave mission")),
            icon: "folder-minus",
            disabled: id === null,
            ...(id === null ? { detail: blockLabel("not-allowed", "", resolve) } : {}),
          }),
        )),
    {
      id: "mission-add",
      label: resolve(msg("Add to mission")),
      icon: "folder-plus",
      separatorBefore: single === undefined,
      disabled: inMission || missions.length === 0,
      ...(inMission
        ? { detail: resolve(msg("In a mission")) }
        : missions.length === 0
          ? { detail: resolve(msg("No missions yet")) }
          : {}),
      children: missions.map(({ host, mission }) => {
        const hostLabel = machineLabel(host.environmentId);
        const block = canChangeOn(host.environmentId)
          ? threads
              .map((thread) => missionBlock(thread, host, hosts))
              .find((reason) => reason !== null)
          : "not-allowed";
        return {
          id: `${ADD_PREFIX}${host.environmentId}:${mission.missionId}` as const,
          label: mission.name,
          disabled: block !== undefined,
          detail: block === undefined ? hostLabel : blockLabel(block, hostLabel, resolve),
        };
      }),
    },
  ];
}

interface MissionAddOutcome<T> {
  readonly added: ReadonlyArray<T>;
  readonly refused: ReadonlyArray<string>;
}

export async function addEachToMission<T>(
  threads: ReadonlyArray<T>,
  add: (thread: T) => Promise<string | null>,
): Promise<MissionAddOutcome<T>> {
  const added: Array<T> = [];
  const refused: Array<string> = [];
  for (const thread of threads) {
    const refusal = await add(thread);
    if (refusal === null) added.push(thread);
    else refused.push(refusal);
  }
  return { added, refused };
}

export function missionAddSummary(
  outcome: MissionAddOutcome<unknown>,
  resolve: MFunctionType = mFallback,
): string | null {
  if (outcome.refused.length === 0) return null;
  return resolve(
    msg("{added} added, {refused} refused: {reasons}", {
      added: outcome.added.length,
      refused: outcome.refused.length,
      reasons: [...new Set(outcome.refused)].join(" "),
    }),
  );
}

export interface SidebarMissionEntry<T> {
  readonly member: MissionMember;
  readonly thread: T | null;
}

export interface SidebarMission<T> {
  readonly key: string;
  readonly host: EnvironmentId;
  readonly mission: Mission;
  readonly lead: SidebarMissionEntry<T>;
  readonly leadInScope: boolean;
  readonly members: ReadonlyArray<SidebarMissionEntry<T>>;
}

type ListedThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "settledOverride" | "archivedAt"
>;

const HOLD: Record<MissionMember["state"], number> = {
  active: 2,
  offline: 1,
  "release-pending": 1,
  "release-refused": 2,
  "add-pending": 0,
  "add-refused": -1,
  deleted: -1,
};

export const isJoined = (member: MissionMember) =>
  member.state === "active" || member.state === "offline" || member.state === "release-refused";

function missionHolders(hosts: ReadonlyArray<MissionHost>) {
  const holders = new Map<
    string,
    {
      readonly key: string;
      readonly host: EnvironmentId;
      readonly mission: Mission;
      readonly member: MissionMember;
      readonly hold: number;
    }
  >();
  for (const host of hosts) {
    for (const mission of host.snapshot.missions) {
      for (const member of mission.members) {
        const hold = member.role === "lead" ? 3 : HOLD[member.state];
        const thread = scopedThreadKey(member.ref);
        if (hold >= 0 && hold > (holders.get(thread)?.hold ?? -1)) {
          const key = `${host.environmentId}:${mission.missionId}`;
          holders.set(thread, { key, host: host.environmentId, mission, member, hold });
        }
      }
    }
  }
  return holders;
}

// A list builds a menu for each row from the same snapshot, so each snapshot is indexed once.
const missionIndexes = new WeakMap<
  ReadonlyArray<MissionHost>,
  {
    readonly holders: ReturnType<typeof missionHolders>;
    readonly claims: ReadonlyMap<string, MissionsSnapshot["claims"][number]>;
  }
>();

function missionIndex(hosts: ReadonlyArray<MissionHost>) {
  let index = missionIndexes.get(hosts);
  if (index === undefined) {
    const claims = new Map<string, MissionsSnapshot["claims"][number]>();
    const seenHosts = new Set<EnvironmentId>();
    for (const host of hosts) {
      if (seenHosts.has(host.environmentId)) continue;
      seenHosts.add(host.environmentId);
      for (const claim of host.snapshot.claims) {
        const key = scopedThreadKey(scopeThreadRef(host.environmentId, claim.threadId));
        if (!claims.has(key)) claims.set(key, claim);
      }
    }
    index = { holders: missionHolders(hosts), claims };
    missionIndexes.set(hosts, index);
  }
  return index;
}

// Once a machine has synced, a member thread missing from the list is one the server trimmed as
// settled or the tag filter hid, so an older server's missing `settled` flag cannot leave a blank row.
const isHiddenFromMission = (
  member: MissionMember,
  thread: Pick<ListedThread, "settledOverride" | "archivedAt"> | null,
  syncedEnvironments: ReadonlySet<EnvironmentId>,
) =>
  member.state === "active" &&
  syncedEnvironments.has(member.ref.environmentId) &&
  (thread === null || isSettledMissionMember(thread));

export function groupSidebarMissions<T extends ListedThread>(
  hosts: ReadonlyArray<MissionHost>,
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  unavailableLeads: ReadonlySet<string> = new Set(),
  syncedEnvironments: ReadonlySet<EnvironmentId> = new Set(),
): {
  readonly missions: ReadonlyArray<SidebarMission<T>>;
  readonly threadKeys: ReadonlySet<string>;
  readonly leads: ReadonlyArray<SidebarMissionEntry<T>>;
} {
  const keyOf = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const threadByKey = new Map(threads.map((thread) => [keyOf(thread), thread]));
  const inScope = (thread: T) =>
    scopedProjectKeys === null ||
    scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`);
  const listed = hosts.flatMap((host) =>
    host.snapshot.missions.map((mission) => ({
      key: `${host.environmentId}:${mission.missionId}`,
      host: host.environmentId,
      mission,
    })),
  );
  const { holders } = missionIndex(hosts);
  const threadKeys = new Set<string>();
  const leads: Array<SidebarMissionEntry<T>> = [];
  const missions = listed.flatMap(({ key, host, mission }): Array<SidebarMission<T>> => {
    const entries = mission.members.flatMap((listed): Array<SidebarMissionEntry<T>> => {
      const threadKey = scopedThreadKey(listed.ref);
      const member: MissionMember =
        listed.role === "lead" &&
        listed.state === "active" &&
        !threadByKey.has(threadKey) &&
        unavailableLeads.has(threadKey)
          ? { ...listed, state: "deleted" }
          : listed;
      const claimed = member.state !== "deleted" && member.state !== "add-refused";
      if (claimed && holders.get(threadKey)?.key !== key) return [];
      const thread = claimed ? (threadByKey.get(threadKey) ?? null) : null;
      if (member.role === "member" && isHiddenFromMission(member, thread, syncedEnvironments)) {
        return [];
      }
      if (thread !== null) threadKeys.add(threadKey);
      return [{ member, thread }];
    });
    const [lead, ...members] = entries;
    if (lead?.member.role !== "lead") return [];
    leads.push(lead);
    const shownMembers =
      scopedProjectKeys === null
        ? members
        : members.filter((entry) => entry.thread !== null && inScope(entry.thread));
    const leadInScope = lead.thread === null ? scopedProjectKeys === null : inScope(lead.thread);
    const leadLoading = lead.thread === null && lead.member.state === "active";
    if (!leadInScope && !leadLoading && shownMembers.length === 0) return [];
    return [{ key, host, mission, lead, leadInScope, members: shownMembers }];
  });
  return { missions, threadKeys, leads };
}

export const newMissionId = () => SecureRandom.uuidV4Unsafe().replaceAll("-", "").slice(0, 12);

export type MissionDraftIntent =
  | { readonly kind: "new" }
  | {
      readonly kind: "lead";
      readonly host: EnvironmentId;
      readonly missionId: string;
      readonly name: string;
      readonly expectedLead: ThreadId;
    }
  | {
      readonly kind: "member";
      readonly host: EnvironmentId;
      readonly missionId: string;
      readonly name: string;
    };

export function missionDraftMachines(
  intent: MissionDraftIntent,
  hosts: ReadonlyArray<MissionHost>,
): ReadonlySet<EnvironmentId> | null {
  if (intent.kind === "new") return null;
  const host = hosts.find((candidate) => candidate.environmentId === intent.host);
  if (intent.kind === "member" && host?.snapshot.linksHidden === true) return null;
  const links =
    intent.kind === "member"
      ? (host?.snapshot.links.filter((link) => link.fullAccess).map((link) => link.environmentId) ??
        [])
      : [];
  return new Set([intent.host, ...links]);
}

export function missionScratchHome(
  machines: ReadonlySet<EnvironmentId> | null,
  usual: EnvironmentId | null,
  scratchRootFor: (environmentId: EnvironmentId) => string | null,
): EnvironmentId | null {
  if (machines === null || (usual !== null && machines.has(usual))) return usual;
  return [...machines].find((environmentId) => scratchRootFor(environmentId) !== null) ?? null;
}

// The wake's turn item id is derived from its `message:mission-update:` message id.
const MISSION_UPDATE_ITEM_ID_PREFIX = "turn-item:message:message%3Amission-update%3A";

const isMissionUpdateNotification = (item: OrchestrationV2TurnItem) =>
  item.type === "notification" &&
  item.id.startsWith(MISSION_UPDATE_ITEM_ID_PREFIX) &&
  item.source.kind === "system" &&
  item.summary === "Mission update";

const MISSION_READ_TOOLS: ReadonlySet<string> = new Set(["t3_thread_read", "t3_mission_roster"]);

// `\u` and `\x` escapes can spell a name the scans below cannot read.
const CODE_MODE_ESCAPE =
  /\b(?:fetch|eval|globalThis|this|Reflect|Object)\b|\b(?:search|Function|import)\s*\(|\\[ux]/;
const NON_T3_TOOLS_ACCESS =
  /\btools\b(?!\s*\[\s*(?:"t3-code[^"\n]*"|'t3-code[^'\n]*')\s*\]|\s*\.\s*t3[\w$]*)/;
const NAMESPACE_USE =
  /(\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?\btools\s*(?:\[\s*(?:"t3-code[^"\n]*"|'t3-code[^'\n]*')\s*\]|\.\s*t3[\w$]*)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
const MEMBER = /^\s*\.\s*([A-Za-z_$][\w$]*)/;
const STATEMENT_END = /^\s*(?:;|\n|$)/;
const COMPUTED_KEY_OPEN = /([\w$]+|[)\]])\s*\[/g;
// After these words `[` opens an array, not a computed key.
const ARRAY_LITERAL_AFTER: ReadonlySet<string> = new Set([
  "return",
  "of",
  "in",
  "await",
  "yield",
  "typeof",
  "void",
  "delete",
  "case",
  "throw",
  "new",
  "else",
  "do",
]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Whether a computed key is an index, the T3 namespace, or a plain assignment target such as
 * `out[id] = …`. Any other computed key could build a tool name the name scan cannot see.
 */
function computedKeysAreSafe(code: string): boolean {
  for (const match of code.matchAll(COMPUTED_KEY_OPEN)) {
    const before = match[1] ?? "";
    if (ARRAY_LITERAL_AFTER.has(before)) continue;
    const rest = code.slice(match.index + match[0].length);
    const safe =
      /^\s*\d+\s*\]/.test(rest) ||
      (/^\s*(?:"t3-code[^"\n]*"|'t3-code[^'\n]*')\s*\]/.test(rest) && before === "tools") ||
      /^[^[\]\n]*\]\s*=(?!=)/.test(rest);
    if (!safe) return false;
  }
  return true;
}

/**
 * An OpenCode Code Mode script reads only when each use of the T3 namespace, directly or through
 * a `const` alias, calls a mission read, and it names no other T3 tool.
 */
function codeModeOnlyReads(input: unknown): boolean {
  const code =
    typeof input === "object" && input !== null && "code" in input ? input.code : undefined;
  if (
    typeof code !== "string" ||
    CODE_MODE_ESCAPE.test(code) ||
    NON_T3_TOOLS_ACCESS.test(code) ||
    !computedKeysAreSafe(code)
  ) {
    return false;
  }
  const names = code.match(IDENTIFIER) ?? [];
  if (
    names.some(
      (name) =>
        (name.startsWith("t3_") || T3_MCP_TOOL_NAMES.has(name)) && !MISSION_READ_TOOLS.has(name),
    )
  ) {
    return false;
  }
  let reads = 0;
  const aliases: Array<{ readonly name: string; readonly declaredAt: number }> = [];
  for (const use of code.matchAll(NAMESPACE_USE)) {
    const [whole, declaration, alias, member, accessed] = use;
    if (declaration !== undefined && alias !== undefined && member === undefined) {
      if (!STATEMENT_END.test(code.slice(use.index + whole.length))) return false;
      const keyword = /^(?:const|let|var)\s+/.exec(declaration)?.[0].length ?? 0;
      aliases.push({ name: alias, declaredAt: use.index + keyword });
    } else if (declaration === undefined && accessed !== undefined) {
      if (!MISSION_READ_TOOLS.has(accessed)) return false;
      reads += 1;
    } else {
      return false;
    }
  }
  for (const { name, declaredAt } of aliases) {
    const occurrence = new RegExp(`(^|[^\\w$.])${name.replaceAll("$", "\\$")}(?![\\w$])`, "g");
    for (const found of code.matchAll(occurrence)) {
      const at = found.index + (found[1]?.length ?? 0);
      if (at === declaredAt) continue;
      const accessed = MEMBER.exec(code.slice(at + name.length))?.[1];
      if (accessed === undefined || !MISSION_READ_TOOLS.has(accessed)) return false;
      reads += 1;
    }
  }
  return reads > 0;
}

// The server's conversation-only history page leaves out these item types
// (`isConversationHistoryItem`), so a run with none of them may be missing its actions.
const WORK_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "reasoning",
  "file_change",
  "dynamic_tool",
]);

const isQuietReply = (text: string) => {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === MISSION_QUIET_REPLY;
};

function classifyChangesNothing(item: OrchestrationV2TurnItem): boolean {
  if (item.status !== "completed" || item.deferredWork !== undefined) return false;
  switch (item.type) {
    case "assistant_message":
      return !item.streaming && item.textOmitted !== true && isQuietReply(item.text);
    case "reasoning":
      return !item.streaming;
    case "checkpoint":
      return item.files.length === 0 && item.filesOmitted !== true;
    case "dynamic_tool":
      return item.toolName === "execute"
        ? codeModeOnlyReads(item.input)
        : MISSION_READ_TOOLS.has(resolveT3McpToolId(item.toolName) ?? "");
    default:
      return false;
  }
}

const changesNothingByItem = new WeakMap<OrchestrationV2TurnItem, boolean>();

function changesNothing(item: OrchestrationV2TurnItem): boolean {
  let known = changesNothingByItem.get(item);
  if (known === undefined) {
    known = classifyChangesNothing(item);
    changesNothingByItem.set(item, known);
  }
  return known;
}

type RunStatus = Pick<OrchestrationV2Run, "id" | "status">;
type AttemptStatus = Pick<OrchestrationV2RunAttempt, "runId" | "attemptOrdinal" | "status">;

const NO_QUIET_RUNS: ReadonlySet<RunId> = new Set();

interface QuietMissionUpdates {
  readonly runs: ReadonlyArray<RunStatus> | undefined;
  readonly attempts: ReadonlyArray<AttemptStatus> | undefined;
  readonly runIds: ReadonlySet<RunId>;
  shown?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}

const quietMissionUpdates = new WeakMap<
  ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  QuietMissionUpdates
>();

function quietMissionUpdateEntry(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<RunStatus> | undefined,
  attempts: ReadonlyArray<AttemptStatus> | undefined,
): QuietMissionUpdates {
  const cached = quietMissionUpdates.get(rows);
  if (cached !== undefined && cached.runs === runs && cached.attempts === attempts) return cached;
  const completedRuns = new Set(
    (runs ?? []).flatMap((run) => (run.status === "completed" ? [run.id] : [])),
  );
  const latestAttempts = new Map<RunId, AttemptStatus>();
  for (const attempt of attempts ?? []) {
    const latest = latestAttempts.get(attempt.runId);
    if (latest === undefined || attempt.attemptOrdinal > latest.attemptOrdinal) {
      latestAttempts.set(attempt.runId, attempt);
    }
  }
  const quiet = new Map<RunId, boolean>();
  const workLoaded = new Set<RunId>();
  const ordinals = new Map<RunId, Array<number>>();
  for (const { item } of rows) {
    if (item.runId === null) continue;
    if (WORK_ITEM_TYPES.has(item.type)) workLoaded.add(item.runId);
    const known = quiet.get(item.runId);
    if (known === undefined) {
      const isQuiet =
        isMissionUpdateNotification(item) &&
        completedRuns.has(item.runId) &&
        latestAttempts.get(item.runId)?.status === "completed";
      quiet.set(item.runId, isQuiet);
      if (isQuiet) ordinals.set(item.runId, [item.ordinal]);
    } else if (known && !changesNothing(item)) {
      quiet.set(item.runId, false);
    } else if (known) {
      ordinals.get(item.runId)?.push(item.ordinal);
    }
  }
  // A run's items have consecutive ordinals from its wake, so a gap is an item that is not loaded.
  const fullyLoaded = (runId: RunId) => {
    const loaded = ordinals.get(runId) ?? [];
    const wake = loaded[0];
    return (
      wake !== undefined &&
      [...loaded]
        .sort((left, right) => left - right)
        .every((ordinal, index) => ordinal === wake + index)
    );
  };
  const runIds = new Set(
    [...quiet].flatMap(([runId, isQuiet]) =>
      isQuiet && workLoaded.has(runId) && fullyLoaded(runId) ? [runId] : [],
    ),
  );
  const entry: QuietMissionUpdates = {
    runs,
    attempts,
    runIds: runIds.size === 0 ? NO_QUIET_RUNS : runIds,
  };
  quietMissionUpdates.set(rows, entry);
  return entry;
}

/**
 * The finished mission-update runs in which the lead only read and wrote nothing new. Returns the
 * same set as the previous call while `rows`, `runs` and `attempts` are the same references.
 */
export function quietMissionUpdateRunIds(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<RunStatus> | undefined,
  attempts: ReadonlyArray<AttemptStatus> | undefined,
): ReadonlySet<RunId> {
  return quietMissionUpdateEntry(rows, runs, attempts).runIds;
}

/**
 * `rows` without the items of `quietMissionUpdateRunIds`. Returns `rows` itself when nothing is
 * dropped, and the same array as the previous call while the three references match.
 */
export function withoutQuietMissionUpdates(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<RunStatus> | undefined,
  attempts: ReadonlyArray<AttemptStatus> | undefined,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const entry = quietMissionUpdateEntry(rows, runs, attempts);
  entry.shown ??=
    entry.runIds.size === 0
      ? rows
      : rows.filter(({ item }) => item.runId === null || !entry.runIds.has(item.runId));
  return entry.shown;
}

export function missionLeadCandidates<
  T extends MissionCandidate & Pick<EnvironmentThreadShell, "archivedAt" | "title">,
>(
  threads: ReadonlyArray<T>,
  mission: { readonly host: EnvironmentId; readonly missionId: string },
  hosts: ReadonlyArray<MissionHost>,
) {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === mission.host &&
        thread.archivedAt === null &&
        threadHasMessages(thread) &&
        (claimHere(thread, hosts)?.missionId ?? mission.missionId) === mission.missionId,
    )
    .sort((left, right) =>
      (right.latestUserMessageAt ?? "").localeCompare(left.latestUserMessageAt ?? ""),
    );
}
