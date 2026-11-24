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
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";

/** The Missions one machine keeps: those whose lead thread is on it. */
export interface MissionHost {
  readonly environmentId: EnvironmentId;
  readonly snapshot: MissionsSnapshot;
}

export interface MissionCandidate {
  readonly environmentId: EnvironmentId;
  readonly id?: ThreadId;
  /** Only a thread with messages may start a Mission. */
  readonly latestUserMessageAt: string | null;
  readonly visibleItemCount: number;
}

type MissionThread = Pick<MissionCandidate, "environmentId" | "id">;

export type MissionMenuId =
  | "mission-start"
  | "mission-leave"
  | "mission-add"
  | `mission-add:${string}`
  | `mission-release:${string}`;

export const isMissionMenuId = (id: string): id is MissionMenuId => id.startsWith("mission-");

const ADD_PREFIX = "mission-add:";
const RELEASE_PREFIX = "mission-release:";

/** Mission ids are hex, so the last colon separates them from the host's environment id. */
export function parseMissionTarget(id: MissionMenuId): {
  readonly action: "add" | "release";
  readonly environmentId: EnvironmentId;
  readonly missionId: string;
} | null {
  const prefix = [ADD_PREFIX, RELEASE_PREFIX].find((candidate) => id.startsWith(candidate));
  if (prefix === undefined) return null;
  const rest = id.slice(prefix.length);
  const split = rest.lastIndexOf(":");
  return {
    action: prefix === ADD_PREFIX ? "add" : "release",
    environmentId: rest.slice(0, split) as EnvironmentId,
    missionId: rest.slice(split + 1),
  };
}

export type MissionBlock = "in-mission" | "empty" | "no-link" | "fenced" | "not-allowed";

/**
 * The claim this thread's own machine holds for it, when one Mission or another holds it there.
 * The claim decides, never the thread's tags: a tag can lag behind its claim.
 */
export const claimHere = (thread: MissionThread, hosts: ReadonlyArray<MissionHost>) =>
  hosts
    .find((host) => host.environmentId === thread.environmentId)
    ?.snapshot.claims.find((claim) => claim.threadId === thread.id);

/**
 * Why a thread cannot join a Mission kept on `host`. A thread on another machine needs the host's
 * link to that machine to have full access, because a weaker link may change only threads it started.
 */
function missionBlock(
  thread: MissionCandidate,
  host: MissionHost,
  hosts: ReadonlyArray<MissionHost>,
): MissionBlock | null {
  if (claimHere(thread, hosts) !== undefined) return "in-mission";
  // An empty thread may still be a draft that T3 deletes on its own.
  if (!threadHasMessages(thread)) return "empty";
  if (thread.environmentId === host.environmentId) return null;
  const link = host.snapshot.links.find((entry) => entry.environmentId === thread.environmentId);
  if (link === undefined) return "no-link";
  return link.fullAccess ? null : "fenced";
}

/** Short, because a menu entry's detail never shrinks and would crowd out its label. */
function blockLabel(block: MissionBlock, hostLabel: string, resolve: MessageResolver) {
  switch (block) {
    case "in-mission":
      return resolve(msg("In a mission"));
    case "empty":
      return resolve(msg("No messages yet"));
    case "no-link":
      return resolve(msg("No link from {machine}", { machine: hostLabel }));
    case "fenced":
      return resolve(msg("Needs full-access link"));
    case "not-allowed":
      return resolve(msg("Not allowed here"));
  }
}

/**
 * "Start mission from this thread" and "Leave mission" for one thread, and "Add to mission" for
 * one or more.
 */
export function buildMissionMenuItems(
  threads: ReadonlyArray<MissionCandidate>,
  hosts: ReadonlyArray<MissionHost>,
  machineLabel: (environmentId: EnvironmentId) => string,
  /** Whether this client may change the Missions a machine keeps; one source for every path. */
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
  // The Mission whose lead may release this thread: the one the sidebar lists it under.
  const holding =
    single?.id === undefined
      ? undefined
      : missionHolders(hosts).get(scopedThreadKey(scopeThreadRef(single.environmentId, single.id)));
  const heldBy =
    holding !== undefined && holding.member.role === "member" && isJoined(holding.member)
      ? holding
      : undefined;
  return [
    ...(single === undefined
      ? []
      : [
          {
            id: "mission-start" as const,
            label: resolve(msg("Start mission from this thread")),
            icon: "flag",
            separatorBefore: true,
            disabled:
              inMission ||
              startHost === undefined ||
              !threadHasMessages(single) ||
              !canChangeOn(single.environmentId),
            ...(inMission
              ? { detail: resolve(msg("In a mission")) }
              : startHost === undefined
                ? { detail: resolve(msg("Not supported here")) }
                : !threadHasMessages(single)
                  ? { detail: resolve(msg("No messages yet")) }
                  : !canChangeOn(single.environmentId)
                    ? { detail: blockLabel("not-allowed", "", resolve) }
                    : {}),
          },
        ]),
    ...(heldBy === undefined
      ? []
      : [
          {
            id: `${RELEASE_PREFIX}${heldBy.host}:${heldBy.mission.missionId}` as const,
            label: resolve(msg("Release from mission")),
            icon: "flag",
            disabled: !canChangeOn(heldBy.host),
            ...(canChangeOn(heldBy.host) ? {} : { detail: blockLabel("not-allowed", "", resolve) }),
          },
        ]),
    ...(single === undefined || claimHere(single, hosts) === undefined
      ? []
      : [
          {
            id: "mission-leave" as const,
            label: resolve(msg("Leave mission")),
            icon: "flag",
            disabled: !canChangeOn(single.environmentId),
            ...(canChangeOn(single.environmentId)
              ? {}
              : { detail: blockLabel("not-allowed", "", resolve) }),
          },
        ]),
    {
      id: "mission-add",
      label: resolve(msg("Add to mission")),
      icon: "flag",
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

/** How a batch of adds went: each thread is tried, whatever happened to the ones before it. */
export interface MissionAddOutcome<T> {
  readonly added: ReadonlyArray<T>;
  /** Why each refused thread was refused. */
  readonly refused: ReadonlyArray<string>;
}

/** Tries `add` for every thread in turn. `add` answers why it refused, or null when it added. */
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

/** One line for the whole batch, or null when nothing was refused. */
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

/** A row in a Mission: drawn as its thread's own row when this client has the thread. */
export interface SidebarMissionEntry<T> {
  readonly member: MissionMember;
  readonly thread: T | null;
}

export interface SidebarMission<T> {
  /** The lead's machine and the Mission id, as its collapse state is kept. */
  readonly key: string;
  readonly host: EnvironmentId;
  readonly mission: Mission;
  readonly lead: SidebarMissionEntry<T>;
  /** False when a project scope hides the lead: it still heads its Mission, but only that. */
  readonly leadInScope: boolean;
  readonly members: ReadonlyArray<SidebarMissionEntry<T>>;
}

type ListedThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "projectId" | "settledOverride" | "archivedAt"
>;

/** How surely a Mission holds a thread. A current claim wins over a last-known or pending one. */
const HOLD: Record<MissionMember["state"], number> = {
  active: 2,
  offline: 1,
  "release-pending": 1,
  "add-pending": 0,
  "add-refused": -1,
  deleted: -1,
};

const isJoined = (member: MissionMember) => member.state === "active" || member.state === "offline";

/** Where each thread shows: the Mission it leads, else the one that holds it surest, else the first. */
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

/**
 * The Missions the sidebar lists, and `threadKeys`, the threads they show; other lists leave those
 * out. A thread shows in one Mission: the one it leads, else the surest hold, else the first.
 * A settled or archived member goes back to the other lists unless its add or release waits.
 */
export function groupSidebarMissions<T extends ListedThread>(
  hosts: ReadonlyArray<MissionHost>,
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  /** Leads whose thread was read for and not found, such as an archived one. */
  unavailableLeads: ReadonlySet<string> = new Set(),
): {
  readonly missions: ReadonlyArray<SidebarMission<T>>;
  readonly threadKeys: ReadonlySet<string>;
  /** Every listed Mission's lead, whatever the scope. */
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
      // Shown as a deleted lead is: it heads its mission, and nothing waits for it.
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
    // A lead the shell left out is still on its way, and only its project can decide the scope.
    const leadLoading = lead.thread === null && lead.member.state === "active";
    if (!leadInScope && !leadLoading && shownMembers.length === 0) return [];
    return [{ key, host, mission, lead, leadInScope, members: shownMembers }];
  });
  return { missions, threadKeys, leads };
}

/** What a draft does on its first send: start a Mission it leads, or lead one whose lead is gone. */
export type MissionDraftIntent =
  | { readonly kind: "new" }
  | {
      readonly kind: "lead";
      readonly host: EnvironmentId;
      readonly missionId: string;
      readonly name: string;
    };

/** The members a drag can take out of their Mission: joined ones the sidebar shows. */
export function missionDragKeys(missions: ReadonlyArray<SidebarMission<unknown>>) {
  return new Set(
    missions.flatMap((mission) =>
      mission.members.flatMap((entry) =>
        entry.thread !== null && isJoined(entry.member) ? [scopedThreadKey(entry.member.ref)] : [],
      ),
    ),
  );
}

/** What a sidebar drag does where it is: add threads to a Mission, or take a member out of one. */
export interface MissionDrop {
  readonly kind: "add" | "release";
  /** The Mission's key, as the sidebar lists it. */
  readonly mission: string;
  readonly host: EnvironmentId;
  readonly missionId: string;
  /** Why it does not drop, or null. */
  readonly refusal: string | null;
}

export function resolveMissionDrop(input: {
  /** The thread the drag started on. A selection drags all of `threads`. */
  readonly dragged: string;
  readonly threads: ReadonlyArray<MissionCandidate>;
  /** A listed Mission's key, or `list` for the threads in no Mission. */
  readonly over: string | null;
  readonly missions: ReadonlyArray<SidebarMission<unknown>>;
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly canChangeOn: (environmentId: EnvironmentId) => boolean;
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
    return from === undefined
      ? null
      : {
          kind: "release",
          mission: from.key,
          host: from.host,
          missionId: from.mission.missionId,
          refusal: notAllowed(from.host),
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

/**
 * Threads that can take over a Mission whose lead is gone: on its machine, with messages, and
 * in no other Mission. Its own members can. Most recently written first.
 */
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
