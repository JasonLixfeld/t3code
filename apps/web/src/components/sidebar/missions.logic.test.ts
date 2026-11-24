import {
  EnvironmentId,
  type Mission,
  type MissionLink,
  type MissionMember,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addEachToMission,
  buildMissionMenuItems,
  groupSidebarMissions,
  missionAddSummary,
  type MissionHost,
  parseMissionTarget,
} from "./missions.logic";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const BOX = EnvironmentId.make("env-box");
const OTHER = EnvironmentId.make("env-other");

const mission: Mission = {
  missionId: "0123456789ab",
  name: "Ship v2",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [],
};
const links: ReadonlyArray<MissionLink> = [
  { environmentId: LAPTOP, label: "Laptop", fullAccess: true },
  { environmentId: BOX, label: "Box", fullAccess: false },
];
const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: {
      missions: [mission],
      links,
      claims: [{ threadId: ThreadId.make("held"), missionId: "ffffffffffff", name: "Theirs" }],
    },
  },
];
const label = (environmentId: EnvironmentId) =>
  environmentId === DESK ? "Desk" : String(environmentId);
const allowed = () => true;
/** A thread with messages, as every thread that may lead a mission has. */
const thread = (environmentId: EnvironmentId, id?: string) => ({
  environmentId,
  ...(id === undefined ? {} : { id: ThreadId.make(id) }),
  latestUserMessageAt: "2026-11-23T00:00:00.000Z",
  visibleItemCount: 1,
});

const addChild = (threads: Parameters<typeof buildMissionMenuItems>[0]) =>
  buildMissionMenuItems(threads, hosts, label, allowed).find((item) => item.id === "mission-add")!
    .children![0]!;

describe("buildMissionMenuItems", () => {
  it("offers a mission to threads on its machine and behind a full-access link", () => {
    expect(addChild([thread(DESK), thread(LAPTOP)])).toEqual({
      id: "mission-add:env-desk:0123456789ab",
      label: "Ship v2",
      disabled: false,
      detail: "Desk",
    });
  });

  it("says why a thread cannot join", () => {
    expect(addChild([thread(BOX)])).toMatchObject({
      disabled: true,
      detail: "Needs full-access link",
    });
    expect(addChild([thread(OTHER)])).toMatchObject({
      disabled: true,
      detail: "No link from Desk",
    });
    // The claim its own machine holds decides, not a tag the thread carries.
    const held = buildMissionMenuItems([thread(DESK, "held")], hosts, label, allowed);
    expect(held.map((item) => [item.id, item.disabled, item.detail])).toEqual([
      ["mission-start", true, "In a mission"],
      ["mission-leave", false, undefined],
      ["mission-add", true, "In a mission"],
    ]);
  });

  it("starts missions only for one thread on a machine that runs them", () => {
    expect(buildMissionMenuItems([thread(DESK)], hosts, label, allowed)[0]).toMatchObject({
      id: "mission-start",
      disabled: false,
    });
    expect(buildMissionMenuItems([thread(LAPTOP)], hosts, label, allowed)[0]).toMatchObject({
      id: "mission-start",
      disabled: true,
    });
    expect(
      buildMissionMenuItems([thread(DESK), thread(DESK)], hosts, label, allowed).map(
        (item) => item.id,
      ),
    ).toEqual(["mission-add"]);
  });

  it("adds a thread with no messages as a member, but does not start a mission from it", () => {
    const empty = { ...thread(DESK), latestUserMessageAt: null, visibleItemCount: 0 };
    const items = buildMissionMenuItems([empty], hosts, label, allowed);
    expect(items[0]).toMatchObject({
      id: "mission-start",
      disabled: true,
      detail: "No messages yet",
    });
    const add = items.find((item) => item.id === "mission-add")!;
    expect(add.disabled).toBe(false);
    expect(add.children!.every((child) => child.disabled === false)).toBe(true);
  });

  it("gives a mission's lead the mission's own group, deletable only with no members", () => {
    const led = (members: ReadonlyArray<MissionMember>): ReadonlyArray<MissionHost> => [
      {
        environmentId: DESK,
        snapshot: {
          missions: [
            {
              ...mission,
              members: [
                {
                  ref: { environmentId: DESK, threadId: ThreadId.make("lead") },
                  role: "lead",
                  state: "active",
                },
                ...members,
              ],
            },
          ],
          links,
          claims: [],
        },
      },
    ];
    // A lead gets only its mission's group: it cannot start, join or leave a mission.
    const group = (members: ReadonlyArray<MissionMember>) =>
      buildMissionMenuItems([thread(DESK, "lead")], led(members), label, allowed).map((item) => [
        item.id,
        item.header ?? item.disabled ?? false,
        item.detail,
      ]);
    expect(group([])).toEqual([
      ["mission-group", true, undefined],
      ["mission-new-thread:env-desk:0123456789ab", false, undefined],
      ["mission-delete:env-desk:0123456789ab", false, undefined],
    ]);
    const member = (state: MissionMember["state"]): MissionMember => ({
      ref: { environmentId: LAPTOP, threadId: ThreadId.make("m") },
      role: "member",
      state,
    });
    expect(group([member("add-pending")]).at(-1)).toEqual([
      "mission-delete:env-desk:0123456789ab",
      true,
      "Has threads",
    ]);
    // A refused add never joined, so the mission can still go.
    expect(group([member("add-refused")]).at(-1)![1]).toBe(false);
    expect(parseMissionTarget("mission-delete:env-desk:0123456789ab")).toEqual({
      action: "delete",
      environmentId: DESK,
      missionId: "0123456789ab",
    });
  });

  it("refuses single and bulk adds alike where this client may not change missions", () => {
    const nowhere = () => false;
    for (const threads of [[thread(DESK)], [thread(DESK), thread(LAPTOP)]]) {
      const items = buildMissionMenuItems(threads, hosts, label, nowhere);
      const add = items.find((item) => item.id === "mission-add")!;
      expect(add.children![0]).toMatchObject({ disabled: true, detail: "Not allowed here" });
    }
    expect(buildMissionMenuItems([thread(DESK)], hosts, label, nowhere)[0]).toMatchObject({
      id: "mission-start",
      disabled: true,
      detail: "Not allowed here",
    });
  });

  it("offers leaving only for a thread its own machine holds in a mission", () => {
    const leaveOf = (thread: Parameters<typeof buildMissionMenuItems>[0][number], can = allowed) =>
      buildMissionMenuItems([thread], hosts, label, can).find(
        (item) => item.id === "mission-leave",
      );
    expect(leaveOf(thread(DESK, "held"))).toMatchObject({
      label: "Leave mission",
      disabled: false,
    });
    expect(leaveOf(thread(DESK, "free"))).toBeUndefined();
    expect(leaveOf(thread(LAPTOP, "held"))).toBeUndefined();
    expect(leaveOf(thread(DESK, "held"), () => false)).toMatchObject({
      disabled: true,
      detail: "Not allowed here",
    });
  });

  it("offers the lead's machine to release a thread that joined one of its missions", () => {
    const joined: ReadonlyArray<MissionHost> = [
      {
        ...hosts[0]!,
        snapshot: {
          ...hosts[0]!.snapshot,
          missions: [
            {
              ...mission,
              members: [
                {
                  ref: { environmentId: LAPTOP, threadId: ThreadId.make("ios") },
                  role: "member",
                  state: "active",
                },
              ],
            },
          ],
        },
      },
    ];
    const releaseOf = (can: (environmentId: EnvironmentId) => boolean, id = "ios") =>
      buildMissionMenuItems([thread(LAPTOP, id)], joined, label, can).find((item) =>
        item.id.startsWith("mission-release:"),
      );
    expect(releaseOf(allowed)).toMatchObject({
      id: "mission-release:env-desk:0123456789ab",
      label: "Release from mission",
      disabled: false,
    });
    expect(parseMissionTarget(releaseOf(allowed)!.id)).toMatchObject({ action: "release" });
    expect(releaseOf(() => false)).toMatchObject({ disabled: true, detail: "Not allowed here" });
    expect(releaseOf(allowed, "other")).toBeUndefined();
  });

  it("releases a thread from the mission the sidebar lists it under", () => {
    const ios = { ref: { environmentId: LAPTOP, threadId: ThreadId.make("ios") } };
    const twoLeads: ReadonlyArray<MissionHost> = [
      {
        environmentId: DESK,
        snapshot: {
          ...hosts[0]!.snapshot,
          missions: [{ ...mission, members: [{ ...ios, role: "member", state: "offline" }] }],
        },
      },
      {
        environmentId: LAPTOP,
        snapshot: {
          links: [],
          claims: [],
          missions: [
            {
              ...mission,
              missionId: "bbbbbbbbbbbb",
              members: [{ ...ios, role: "member", state: "active" }],
            },
          ],
        },
      },
    ];
    const release = buildMissionMenuItems([thread(LAPTOP, "ios")], twoLeads, label, allowed).find(
      (item) => item.id.startsWith("mission-release:"),
    );
    expect(release?.id).toBe("mission-release:env-laptop:bbbbbbbbbbbb");
  });

  it("reads the host and mission back from an add entry", () => {
    expect(parseMissionTarget("mission-add:env:with:colons:0123456789ab")).toEqual({
      action: "add",
      environmentId: "env:with:colons",
      missionId: "0123456789ab",
    });
  });
});

describe("addEachToMission", () => {
  it("tries every thread after a refusal, keeps the refused ones apart, and sums up in one line", async () => {
    const tried: Array<string> = [];
    const outcome = await addEachToMission(["a", "b", "c", "d"], async (thread) => {
      tried.push(thread);
      return thread === "b" ? 'This thread is already in the mission "One".' : null;
    });
    expect(tried).toEqual(["a", "b", "c", "d"]);
    expect(outcome.added).toEqual(["a", "c", "d"]);
    expect(missionAddSummary(outcome)).toBe(
      '3 added, 1 refused: This thread is already in the mission "One".',
    );
    expect(missionAddSummary({ added: ["a", "b"], refused: [] })).toBeNull();
  });
});

describe("groupSidebarMissions", () => {
  const environmentId = EnvironmentId.make("env-desk");
  const laptop = EnvironmentId.make("env-laptop");
  const shell = (
    id: string,
    extra: { settled?: boolean; archived?: boolean; project?: string } = {},
  ) => ({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make(extra.project ?? "web"),
    settledOverride: extra.settled === true ? ("settled" as const) : null,
    archivedAt: extra.archived === true ? "2026-11-23T00:00:00.000Z" : null,
  });
  const member = (
    threadId: string,
    state: MissionMember["state"],
    role: MissionMember["role"] = "member",
    on = environmentId,
  ): MissionMember => ({
    ref: { environmentId: on, threadId: ThreadId.make(threadId) },
    role,
    state,
  });
  const mission = (missionId: string, members: ReadonlyArray<MissionMember>): Mission => ({
    missionId,
    name: missionId,
    createdAt: "2026-11-23T00:00:00.000Z",
    members,
  });
  const hostOf = (...missions: ReadonlyArray<Mission>): ReadonlyArray<MissionHost> => [
    { environmentId, snapshot: { links: [], claims: [], missions } },
  ];
  const ship = mission("0123456789ab", [
    member("lead", "active", "lead"),
    member("docs", "active"),
    member("done", "active"),
    member("old", "active"),
    member("joining", "add-pending"),
    member("leaving", "release-pending"),
    member("refused", "add-refused"),
    member("remote", "offline", "member", laptop),
  ]);
  const threads = [
    shell("lead"),
    shell("docs"),
    shell("done", { settled: true }),
    shell("old", { archived: true }),
    shell("joining"),
    shell("leaving"),
    shell("refused"),
  ];
  const listed = () => groupSidebarMissions(hostOf(ship), threads, null);
  const entryOf = (threadId: string) =>
    listed().missions[0]!.members.find((entry) => entry.member.ref.threadId === threadId);
  const rowsOf = (result: ReturnType<typeof listed>) =>
    result.missions.map((entry) => [
      entry.key,
      entry.leadInScope,
      entry.members.map((row) => row.member.ref.threadId),
    ]);

  it("shows the lead and unsettled members only in their mission, and settled ones elsewhere", () => {
    const { missions, threadKeys } = listed();
    expect(threadKeys.has("env-desk:lead")).toBe(true);
    expect(threadKeys.has("env-desk:docs")).toBe(true);
    expect(threadKeys.has("env-desk:done")).toBe(false);
    expect(missions[0]!.key).toBe("env-desk:0123456789ab");
    expect(missions[0]!.lead.thread?.id).toBe("lead");
    expect(entryOf("done")).toBeUndefined();
    // A thread this client cannot see keeps the mission's own row.
    expect(entryOf("remote")?.thread).toBeNull();
  });

  it("leaves an archived member out of its mission and to the other lists", () => {
    expect(entryOf("old")).toBeUndefined();
    expect(listed().threadKeys.has("env-desk:old")).toBe(false);
  });

  it("shows a pending add or release it has the thread for in the mission only", () => {
    for (const threadId of ["joining", "leaving"]) {
      expect(entryOf(threadId)?.thread?.id).toBe(threadId);
      expect(listed().threadKeys.has(`env-desk:${threadId}`)).toBe(true);
    }
  });

  it("keeps a refused add's thread in the other lists, and only the refusal in the mission", () => {
    expect(entryOf("refused")).toMatchObject({ member: { state: "add-refused" }, thread: null });
    expect(listed().threadKeys.has("env-desk:refused")).toBe(false);
  });

  it("shows a thread in one mission only: a current claim first, then the first listed", () => {
    const stale = mission("aaaaaaaaaaaa", [
      member("other-lead", "active", "lead"),
      member("docs", "release-pending"),
      member("joining", "active"),
    ]);
    const later = mission("bbbbbbbbbbbb", [
      member("third-lead", "active", "lead"),
      member("docs", "active"),
    ]);
    const shells = [...threads, shell("other-lead"), shell("third-lead")];
    // `joining` waits to be added to the first and is claimed by the second; two current
    // claims on `docs` leave it with the first.
    const result = groupSidebarMissions(hostOf(ship, stale, later), shells, null);
    expect(rowsOf(result)).toEqual([
      ["env-desk:0123456789ab", true, ["docs", "leaving", "refused", "remote"]],
      ["env-desk:aaaaaaaaaaaa", true, ["joining"]],
      ["env-desk:bbbbbbbbbbbb", true, []],
    ]);
    // A current claim wins over a release that still waits, whichever is listed first.
    const twice = groupSidebarMissions(hostOf(stale, later), shells, null);
    expect(rowsOf(twice).map((row) => row[2])).toEqual([["joining"], ["docs"]]);
  });

  it("with a project scope, lists only members in it, under their lead wherever it is", () => {
    const scoped = [...threads, shell("api-docs", { project: "api" })];
    const withApi = mission("0123456789ab", [...ship.members, member("api-docs", "active")]);
    const result = groupSidebarMissions(hostOf(withApi), scoped, new Set(["env-desk:api"]));
    expect(rowsOf(result)).toEqual([["env-desk:0123456789ab", false, ["api-docs"]]]);
    // Every mission thread still stays out of the other lists.
    expect(result.threadKeys.has("env-desk:docs")).toBe(true);
    expect(groupSidebarMissions(hostOf(ship), threads, new Set(["env-desk:api"])).missions).toEqual(
      [],
    );
  });

  it("keeps a mission under a scope while its lead's thread is on its way", () => {
    const waiting = mission("cccccccccccc", [member("old-lead", "active", "lead")]);
    const scope = new Set(["env-desk:web"]);
    const loading = groupSidebarMissions(hostOf(waiting), threads, scope);
    expect(rowsOf(loading)).toEqual([["env-desk:cccccccccccc", false, []]]);
    expect(loading.leads.map((lead) => lead.member.ref.threadId)).toEqual(["old-lead"]);
    // Once it arrives, its project decides.
    const arrived = [...threads, shell("old-lead", { settled: true })];
    expect(rowsOf(groupSidebarMissions(hostOf(waiting), arrived, scope))).toEqual([
      ["env-desk:cccccccccccc", true, []],
    ]);
    expect(
      groupSidebarMissions(hostOf(waiting), arrived, new Set(["env-desk:api"])).missions,
    ).toEqual([]);
  });

  it("leaves every thread to the other lists when no mission is listed", () => {
    expect(groupSidebarMissions([], threads, null)).toEqual({
      missions: [],
      threadKeys: new Set(),
      leads: [],
    });
  });
});
