import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  blockLabel,
  isJoined,
  missionBlock,
  type MissionCandidate,
  type MissionHost,
  missionLeaveId,
  type SidebarMission,
} from "@t3tools/client-runtime/missions";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

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
