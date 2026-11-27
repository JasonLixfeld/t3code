import type { MissionHost } from "@t3tools/client-runtime/missions";
import { EnvironmentId, type MissionMember, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  type MissionMenuContext,
  missingMemberMenuItems,
  missionMenuActions,
  missionPaletteRows,
  threadMissionMenuItems,
} from "./missionMenus";
import type { ThreadListV2MissionPlace } from "./threadListV2";

const DESK = EnvironmentId.make("env-desk");
const ref = (threadId: string) => ({ environmentId: DESK, threadId: ThreadId.make(threadId) });
const member = (threadId: string, state: MissionMember["state"], detail?: string) => ({
  ref: ref(threadId),
  role: "member" as const,
  state,
  ...(detail === undefined ? {} : { detail }),
});
const lead = { ref: ref("lead"), role: "lead" as const, state: "deleted" as const };

const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: {
      links: [],
      claims: [{ threadId: ThreadId.make("refused"), missionId: "m1", name: "Ship v2" }],
      missions: [
        {
          missionId: "m1",
          name: "Ship v2",
          createdAt: "2026-11-23T00:00:00.000Z",
          members: [lead, member("refused", "release-refused", "Busy")],
        },
      ],
    },
  },
];
const shell = (id: string, latestUserMessageAt: string | null = "2026-11-24T00:00:00.000Z") =>
  makeThreadShellFixture({
    environmentId: DESK,
    id: ThreadId.make(id),
    title: id,
    latestUserMessageAt,
  });
const ctx = (allowed = true): MissionMenuContext => ({
  hosts,
  threads: [shell("older", "2026-11-20T00:00:00.000Z"), shell("newer")],
  machineLabel: () => "Desk",
  can: () => allowed,
  resolve: m,
});
const place = (entry: MissionMember): ThreadListV2MissionPlace => ({
  key: `${DESK}:m1`,
  host: DESK,
  missionId: "m1",
  missionName: "Ship v2",
  member: entry,
  toggle: null,
});

describe("missionMenuActions", () => {
  const items = [
    { id: "mission-group", label: "Mission", header: true, separatorBefore: true },
    {
      id: "mission-new-thread:x",
      label: "New thread",
      icon: "message-square-plus",
      disabled: true,
    },
    {
      id: "mission-add",
      label: "Add to mission",
      icon: "folder-plus",
      separatorBefore: true,
      children: [{ id: "mission-add:x", label: "Ship v2", detail: "Desk" }],
    },
  ];

  it("turns headers and separators into iOS sections, and drops headers on Android", () => {
    const newThread = {
      id: "mission-new-thread:x",
      title: "New thread",
      image: "plus.bubble",
      attributes: { disabled: true },
    };
    const add = {
      id: "mission-add",
      title: "Add to mission",
      image: "folder.badge.plus",
      subactions: [{ id: "mission-add:x", title: "Ship v2", subtitle: "Desk" }],
    };
    expect(missionMenuActions(items, true)).toEqual([
      { title: "Mission", displayInline: true, subactions: [newThread] },
      { title: "", displayInline: true, subactions: [add] },
    ]);
    expect(missionMenuActions(items, false)).toEqual([newThread, add]);
  });
});

describe("mission menus", () => {
  it("offers Retry and Dismiss on a member whose leave was refused", () => {
    const rows = threadMissionMenuItems(
      shell("refused"),
      place(member("refused", "release-refused", "Busy")),
      ctx(),
    );
    expect(rows.map((row) => [row.id, row.disabled ?? false])).toEqual([
      ["mission-start", true],
      ["mission-leave:env-desk:m1", false],
      ["mission-add", true],
      ["mission-member-retry", false],
      ["mission-member-forget", false],
    ]);
    expect(
      missingMemberMenuItems(place(member("gone", "add-pending")), ctx(false)).map((row) => [
        row.label,
        row.disabled,
      ]),
    ).toEqual([["Forget", true]]);
  });

  it("lets a gone lead's row pick a new lead from the machine's threads, newest first", () => {
    const rows = missingMemberMenuItems(place(lead), ctx());
    expect(rows.find((row) => row.id === "mission-choose-lead")?.children).toEqual([
      { id: "mission-lead:newer", label: "newer" },
      { id: "mission-lead:older", label: "older" },
    ]);
    const ids = (entry: MissionMember, allowed = true) =>
      missingMemberMenuItems(place(entry), ctx(allowed)).map((row) => row.id);
    expect(ids(lead)).toContain("mission-new-lead");
    expect(ids({ ...lead, state: "active" })).not.toContain("mission-new-lead");
    expect(
      missingMemberMenuItems(place(lead), ctx(false)).find(
        (row) => row.id === "mission-prompt:env-desk:m1",
      )?.disabled,
    ).toBe(true);
  });

  it("lists one palette row per mission the open thread can join", () => {
    const rows = missionPaletteRows(shell("plain"), ctx());
    expect(rows.map((row) => row.id)).toEqual(["mission-start", "mission-add:env-desk:m1"]);
    expect(rows[1]?.title).toContain("Ship v2");
    expect(rows[1]?.detail).toBe("Desk");
    expect(missionPaletteRows(shell("plain"), ctx(false))).toEqual([]);
  });
});
