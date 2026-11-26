import {
  buildMissionMenuItems,
  isThreadMissionAction,
  type MissionCandidate,
  type MissionHost,
  missionLeadCandidates,
  missionLeaveId,
  type MissionMenuId,
  missionRowItems,
} from "@t3tools/client-runtime/missions";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { msg } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";
import type { ThreadListV2MissionPlace } from "./threadListV2";

const SYMBOL_BY_ICON: Readonly<Record<string, string>> = {
  "message-square-plus": "plus.bubble",
  pencil: "pencil",
  trash: "trash",
  "folder-tree": "flowchart",
  "folder-minus": "folder.badge.minus",
  "folder-plus": "folder.badge.plus",
  "rotate-ccw": "arrow.clockwise",
  x: "xmark",
};

/** The Android menu has no inline sections, so it lists the rows without their headers. */
export function missionMenuActions(
  items: ReadonlyArray<ContextMenuItem>,
  inline: boolean,
): MenuAction[] {
  const action = (item: ContextMenuItem): MenuAction => {
    const image = item.icon === undefined ? undefined : SYMBOL_BY_ICON[item.icon];
    return {
      id: item.id,
      title: item.label,
      ...(item.detail ? { subtitle: item.detail } : {}),
      ...(image ? { image } : {}),
      ...(item.disabled || item.destructive
        ? {
            attributes: {
              ...(item.disabled ? { disabled: true } : {}),
              ...(item.destructive ? { destructive: true } : {}),
            },
          }
        : {}),
      ...(item.children ? { subactions: item.children.map(action) } : {}),
    };
  };
  if (!inline) return items.filter((item) => !item.header).map(action);
  const sections: Array<{ readonly title: string; readonly actions: MenuAction[] }> = [];
  for (const item of items) {
    if (item.header || item.separatorBefore || sections.length === 0) {
      sections.push({ title: item.header ? item.label : "", actions: [] });
    }
    if (!item.header) sections.at(-1)!.actions.push(action(item));
  }
  return sections.flatMap((section) =>
    section.actions.length === 0
      ? []
      : [{ title: section.title, displayInline: true, subactions: section.actions }],
  );
}

export const MISSION_MEMBER_RETRY = "mission-member-retry";
export const MISSION_MEMBER_FORGET = "mission-member-forget";
export const MISSION_MEMBER_RELEASE = "mission-member-release";
const LEAD_PREFIX = "mission-lead:";

export const missionLeadPick = (id: string) =>
  id.startsWith(LEAD_PREFIX) ? id.slice(LEAD_PREFIX.length) : null;

export interface MissionMenuContext {
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly can: (right: "change" | "release" | "lead", environmentId: EnvironmentId) => boolean;
  readonly resolve: MessageResolver;
}

const LEAD_CHOICES = 20;

function memberStateItems(
  place: ThreadListV2MissionPlace,
  ctx: MissionMenuContext,
): ContextMenuItem[] {
  const { member } = place;
  const releasable = ctx.can("release", place.host);
  const leaveId = () =>
    missionLeaveId(
      { environmentId: member.ref.environmentId, id: member.ref.threadId },
      { host: place.host, mission: { missionId: place.missionId } },
      ctx.hosts,
      (environmentId) => ctx.can("change", environmentId),
      place.missionId,
    );
  switch (member.state) {
    case "release-refused":
      return [
        {
          id: MISSION_MEMBER_RETRY,
          label: ctx.resolve(msg("Retry")),
          icon: "rotate-ccw",
          disabled: leaveId() === null,
        },
        {
          id: MISSION_MEMBER_FORGET,
          label: ctx.resolve(msg("Dismiss")),
          icon: "x",
          disabled: !releasable,
        },
      ];
    case "add-pending":
    case "release-pending":
      return [
        {
          id: MISSION_MEMBER_FORGET,
          label: ctx.resolve(msg("Forget")),
          icon: "x",
          disabled: !releasable,
        },
      ];
    case "add-refused":
      return [
        {
          id: MISSION_MEMBER_RELEASE,
          label: ctx.resolve(msg("Dismiss")),
          icon: "x",
          disabled: !releasable,
        },
      ];
    case "active":
    case "offline": {
      const id = leaveId();
      return [
        {
          id: id ?? "mission-leave:",
          label: ctx.resolve(msg("Leave mission")),
          icon: "folder-minus",
          disabled: id === null,
        },
      ];
    }
    case "deleted":
      return [];
  }
}

const withoutPromptEditor = (items: ReadonlyArray<ContextMenuItem>) =>
  items.filter((item) => !item.id.startsWith("mission-prompt:"));

export function threadMissionMenuItems(
  thread: MissionCandidate,
  place: ThreadListV2MissionPlace | null,
  ctx: MissionMenuContext,
): ContextMenuItem[] {
  const items = withoutPromptEditor(
    buildMissionMenuItems(
      [thread],
      ctx.hosts,
      ctx.machineLabel,
      (environmentId) => ctx.can("change", environmentId),
      ctx.resolve,
    ),
  );
  const state =
    place === null ||
    place.member.role === "lead" ||
    (place.member.state !== "release-refused" &&
      place.member.state !== "add-pending" &&
      place.member.state !== "release-pending")
      ? []
      : memberStateItems(place, ctx);
  return state.length === 0
    ? items
    : [...items, { ...state[0]!, separatorBefore: true }, ...state.slice(1)];
}

export function missingMemberMenuItems(
  place: ThreadListV2MissionPlace,
  ctx: MissionMenuContext,
): ContextMenuItem[] {
  if (place.member.role === "member") return memberStateItems(place, ctx);
  const mission = ctx.hosts
    .find((host) => host.environmentId === place.host)
    ?.snapshot.missions.find((candidate) => candidate.missionId === place.missionId);
  if (mission === undefined) return [];
  const candidates = missionLeadCandidates(
    ctx.threads,
    { host: place.host, missionId: place.missionId },
    ctx.hosts,
  ).slice(0, LEAD_CHOICES);
  return withoutPromptEditor(
    missionRowItems(
      {
        host: place.host,
        mission,
        leadGone: ctx.can("lead", place.host),
        canChange: ctx.can("change", place.host),
      },
      ctx.resolve,
    ),
  ).map((item) =>
    item.id !== "mission-choose-lead"
      ? item
      : {
          ...item,
          children:
            candidates.length === 0
              ? [
                  {
                    id: "mission-lead:",
                    label: ctx.resolve(msg("No thread here can lead it")),
                    disabled: true,
                  },
                ]
              : candidates.map((candidate) => ({
                  id: `${LEAD_PREFIX}${candidate.id}`,
                  label: candidate.title,
                })),
        },
  );
}

export function missionPaletteRows(
  thread: MissionCandidate,
  ctx: MissionMenuContext,
): ReadonlyArray<{ readonly id: string; readonly title: string; readonly detail?: string }> {
  return threadMissionMenuItems(thread, null, ctx).flatMap((item) => {
    if (item.disabled || !isThreadMissionAction(item.id as MissionMenuId)) return [];
    if (item.children === undefined) return [{ id: item.id, title: item.label }];
    return item.children.flatMap((child) =>
      child.disabled
        ? []
        : [
            {
              id: child.id,
              title: ctx.resolve(msg('Add to mission "{mission}"', { mission: child.label })),
              ...(child.detail ? { detail: child.detail } : {}),
            },
          ],
    );
  });
}
