import type { ContextMenuItem, KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GitBranchIcon,
  HashIcon,
  type LucideIcon,
  MailOpenIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  TimerIcon,
  Trash2Icon,
} from "lucide-react";

import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useMissionMenu } from "./sidebar/MissionsSection";
import { isThreadMissionAction } from "./sidebar/missions.logic";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import type { ThreadActionMenuId } from "./threadActionMenu.logic";

const ICONS: Record<string, LucideIcon> = {
  archive: ArchiveIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "folder-minus": FolderMinusIcon,
  "folder-plus": FolderPlusIcon,
  "folder-tree": FolderTreeIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  "mail-open": MailOpenIcon,
  "message-square": MessageSquareIcon,
  "message-square-plus": MessageSquarePlusIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  "refresh-cw": RefreshCwIcon,
  timer: TimerIcon,
  trash: Trash2Icon,
};

// The palette has its own rows for these, and no inline title editor for rename.
const SKIPPED: ReadonlySet<ThreadActionMenuId> = new Set(["rename", "project-settings"]);

const SHORTCUTS: Partial<Record<ThreadActionMenuId, KeybindingCommand>> = {
  settle: "thread.settle",
  unsettle: "thread.settle",
  pin: "thread.pin",
  unpin: "thread.pin",
  "regenerate-title": "thread.regenerateTitle",
};

const MISSION_ADD_VALUE = "thread-action:mission-add";
export const MISSION_ADD_GROUP_PREFIX = `${MISSION_ADD_VALUE}@`;

function missionAddGroupValue(threadRef: ScopedThreadRef): string {
  return `${MISSION_ADD_GROUP_PREFIX}${JSON.stringify([threadRef.environmentId, threadRef.threadId])}`;
}

export function isMissionAddReason(groups: ReadonlyArray<CommandPaletteGroup>): boolean {
  return (
    groups.length === 1 &&
    groups[0]?.items.length === 1 &&
    groups[0].items[0]?.value === MISSION_ADD_VALUE
  );
}

export function liveMissionAddGroups(
  openGroup: CommandPaletteGroup,
  threadRef: ScopedThreadRef | null,
  items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
): ReadonlyArray<CommandPaletteGroup> | null {
  if (threadRef === null || openGroup.value !== missionAddGroupValue(threadRef)) return null;
  const row = items.find((item) => item.value === MISSION_ADD_VALUE);
  if (row === undefined) return null;
  return row.kind === "submenu"
    ? row.groups
    : [{ value: openGroup.value, label: openGroup.label, items: [row] }];
}

/** The open thread's menu actions (settle, pin, snooze, archive...) as palette rows. */
export function useCommandPaletteThreadActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const missionMenu = useMissionMenu();
  const threadMissionMenu = {
    run: missionMenu.run,
    items: (threads: Parameters<typeof missionMenu.items>[0]) =>
      missionMenu.items(threads).filter((item) => isThreadMissionAction(item.id)),
  };
  const { readMenu } = useThreadActionMenu({
    ...input,
    canShareWithGuest: false,
    missionMenu: threadMissionMenu,
  });
  const menu = readMenu();
  if (!menu) return [];

  const toPaletteItem = (
    item: ContextMenuItem<ThreadActionMenuId>,
  ): CommandPaletteActionItem | CommandPaletteSubmenuItem | null => {
    if (SKIPPED.has(item.id)) return null;
    const Icon = item.icon ? ICONS[item.icon] : undefined;
    const shared = {
      value: `thread-action:${item.id}`,
      searchTerms: [],
      title: item.label,
      icon: Icon ? <Icon className={ITEM_ICON_CLASS} /> : null,
      ...(item.detail ? { description: item.detail } : {}),
      ...(item.disabled ? { disabled: true } : {}),
    };
    if (item.children) {
      // Palette search lists children directly, so they inherit the parent's disabled state.
      const children = item.children.flatMap(
        (child) => toPaletteItem(item.disabled ? { ...child, disabled: true } : child) ?? [],
      );
      if (children.length === 0) {
        const disabledReasonRow: CommandPaletteActionItem = {
          ...shared,
          kind: "action",
          run: async () => {},
        };
        return item.disabled ? disabledReasonRow : null;
      }
      return {
        ...shared,
        kind: "submenu",
        addonIcon: Icon ? <Icon className={ADDON_ICON_CLASS} /> : null,
        groups: [
          {
            value:
              shared.value === MISSION_ADD_VALUE && input.threadRef
                ? missionAddGroupValue(input.threadRef)
                : shared.value,
            label: item.label,
            items: children,
          },
        ],
      };
    }
    const shortcutCommand = SHORTCUTS[item.id];
    return {
      ...shared,
      kind: "action",
      ...(shortcutCommand ? { shortcutCommand } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      run: () => menu.run(item.id),
    };
  };

  return menu.items.flatMap((item) => toPaletteItem(item) ?? []);
}
