import {
  type ContextMenuItem,
  type EnvironmentId,
  missionTagOf,
  type MissionsSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** The Missions one machine keeps: those whose lead thread is on it. */
export interface MissionHost {
  readonly environmentId: EnvironmentId;
  readonly snapshot: MissionsSnapshot;
}

export interface MissionCandidate {
  readonly environmentId: EnvironmentId;
  readonly id?: ThreadId;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export type MissionMenuId =
  | "mission-start"
  | "mission-leave"
  | "mission-add"
  | `mission-add:${string}`;

export const isMissionMenuId = (id: string): id is MissionMenuId => id.startsWith("mission-");

const ADD_PREFIX = "mission-add:";

/** Mission ids are hex, so the last colon separates them from the host's environment id. */
export function parseMissionAddId(
  id: MissionMenuId,
): { readonly environmentId: EnvironmentId; readonly missionId: string } | null {
  if (!id.startsWith(ADD_PREFIX)) return null;
  const rest = id.slice(ADD_PREFIX.length);
  const split = rest.lastIndexOf(":");
  return {
    environmentId: rest.slice(0, split) as EnvironmentId,
    missionId: rest.slice(split + 1),
  };
}

export type MissionBlock = "in-mission" | "no-link" | "fenced" | "not-allowed";

/**
 * Why a thread cannot join a Mission kept on `host`. A thread on another machine needs the host's
 * link to that machine to have full access, because a weaker link may change only threads it started.
 */
function missionBlock(thread: MissionCandidate, host: MissionHost): MissionBlock | null {
  if (missionTagOf(thread.tags) !== undefined) return "in-mission";
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
    case "no-link":
      return resolve(msg("No link from {machine}", { machine: hostLabel }));
    case "fenced":
      return resolve(msg("Needs full-access link"));
    case "not-allowed":
      return resolve(msg("Not allowed here"));
  }
}

/** The claim this thread's own machine holds for it, when one Mission or another holds it there. */
export const claimHere = (thread: MissionCandidate, hosts: ReadonlyArray<MissionHost>) =>
  hosts
    .find((host) => host.environmentId === thread.environmentId)
    ?.snapshot.claims.find((claim) => claim.threadId === thread.id);

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
  const inMission = threads.some((thread) => missionTagOf(thread.tags) !== undefined);
  const missions = hosts.flatMap((host) =>
    host.snapshot.missions.map((mission) => ({ host, mission })),
  );
  const single = threads.length === 1 ? threads[0] : undefined;
  const startHost =
    single === undefined
      ? undefined
      : hosts.find((host) => host.environmentId === single.environmentId);
  return [
    ...(single === undefined
      ? []
      : [
          {
            id: "mission-start" as const,
            label: resolve(msg("Start mission from this thread")),
            icon: "flag",
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
          ? threads.map((thread) => missionBlock(thread, host)).find((reason) => reason !== null)
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
