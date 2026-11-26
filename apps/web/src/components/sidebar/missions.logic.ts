import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ContextMenuItem,
  type EnvironmentId,
  type Mission,
  type MissionMember,
  type MissionsSnapshot,
  type ThreadId,
  threadHasMessages,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";

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

type MissionBlock = "in-mission" | "no-link" | "fenced" | "not-allowed";

export const claimHere = (thread: MissionThread, hosts: ReadonlyArray<MissionHost>) =>
  hosts
    .find((host) => host.environmentId === thread.environmentId)
    ?.snapshot.claims.find((claim) => claim.threadId === thread.id);

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

function missionBlock(
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

function blockLabel(block: MissionBlock, hostLabel: string, resolve: MessageResolver) {
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
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<MissionMenuId>> {
  const target = `${input.host}:${input.mission.missionId}`;
  const members = input.mission.members.filter(
    (member) => member.role === "member" && member.state !== "add-refused",
  );
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
      label: resolve(msg("Delete mission")),
      icon: "trash",
      destructive: true,
      disabled: members.length > 0 || !input.canChange,
      ...(members.length > 0
        ? { detail: resolve(msg("Has threads")) }
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
  resolve: MessageResolver = m,
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
      : missionHolders(hosts).get(scopedThreadKey(scopeThreadRef(single.environmentId, single.id)));
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
  resolve: MessageResolver = m,
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
  SidebarThreadSummary,
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

const isJoined = (member: MissionMember) =>
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

export function groupSidebarMissions<T extends ListedThread>(
  hosts: ReadonlyArray<MissionHost>,
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  unavailableLeads: ReadonlySet<string> = new Set(),
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
  const holders = missionHolders(hosts);
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
      if (
        member.role === "member" &&
        isJoined(member) &&
        thread !== null &&
        (thread.settledOverride === "settled" || thread.archivedAt !== null)
      ) {
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

export function missionDragKeys(missions: ReadonlyArray<SidebarMission<unknown>>) {
  return new Set(
    missions.flatMap((mission) =>
      mission.members.flatMap((entry) =>
        entry.thread !== null && isJoined(entry.member) ? [scopedThreadKey(entry.member.ref)] : [],
      ),
    ),
  );
}

export interface MissionDrop {
  readonly kind: "add" | "release";
  readonly mission: string;
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly refusal: string | null;
}

export function resolveMissionDrop(input: {
  readonly dragged: string;
  readonly threads: ReadonlyArray<MissionCandidate>;
  readonly over: string | null;
  readonly missions: ReadonlyArray<SidebarMission<unknown>>;
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly canChangeOn: (environmentId: EnvironmentId) => boolean;
  readonly source?: { readonly host: EnvironmentId; readonly missionId: string } | null;
  readonly resolve?: MessageResolver;
}): MissionDrop | null {
  const resolve = input.resolve ?? m;
  const from = input.missions.find((mission) =>
    mission.members.some((entry) => scopedThreadKey(entry.member.ref) === input.dragged),
  );
  if (input.over === null || input.over === from?.key) return null;
  const notAllowed = (host: EnvironmentId) =>
    input.canChangeOn(host) ? null : blockLabel("not-allowed", "", resolve);
  if (input.over === "list") {
    const ref = from?.members.find((entry) => scopedThreadKey(entry.member.ref) === input.dragged)
      ?.member.ref;
    const moved =
      input.source != null &&
      from !== undefined &&
      (input.source.host !== from.host || input.source.missionId !== from.mission.missionId);
    return from === undefined || ref === undefined
      ? null
      : {
          kind: "release",
          mission: from.key,
          host: from.host,
          missionId: from.mission.missionId,
          refusal: moved
            ? resolve(msg("This thread moved to another mission."))
            : missionLeaveId(
                  { environmentId: ref.environmentId, id: ref.threadId },
                  from,
                  input.hosts,
                  input.canChangeOn,
                  from.mission.missionId,
                ) === null
              ? blockLabel("not-allowed", "", resolve)
              : null,
        };
  }
  const target = input.missions.find((mission) => mission.key === input.over);
  const host = input.hosts.find((candidate) => candidate.environmentId === target?.host);
  if (target === undefined || host === undefined) return null;
  const block = input.threads
    .map((thread) => missionBlock(thread, host, input.hosts))
    .find((reason) => reason !== null);
  return {
    kind: "add",
    mission: target.key,
    host: target.host,
    missionId: target.mission.missionId,
    refusal:
      notAllowed(target.host) ??
      (block === undefined || block === null
        ? null
        : blockLabel(block, input.machineLabel(target.host), resolve)),
  };
}

export function missionLeadCandidates<
  T extends MissionCandidate & Pick<SidebarThreadSummary, "archivedAt" | "title">,
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
    .toSorted((left, right) =>
      (right.latestUserMessageAt ?? "").localeCompare(left.latestUserMessageAt ?? ""),
    );
}
