import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  MessageId,
  type Mission,
  type MissionLink,
  type MissionMember,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  MISSION_QUIET_REPLY,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  addEachToMission,
  buildMissionMenuItems,
  claimHere,
  groupSidebarMissions,
  missionAddSummary,
  missionDraftMachines,
  missionLeadCandidates,
  missionLeaveId,
  missionRowItems,
  type MissionHost,
  missionsLiveKey,
  parseMissionTarget,
  quietMissionUpdateRunIds,
  withoutQuietMissionUpdates,
} from "./missions.ts";

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
    const unlisted: ReadonlyArray<MissionHost> = hosts.map((host) => ({
      ...host,
      snapshot: { ...host.snapshot, links: [], linksHidden: true },
    }));
    for (const environmentId of [BOX, OTHER]) {
      expect(
        buildMissionMenuItems([thread(environmentId)], unlisted, label, allowed).find(
          (item) => item.id === "mission-add",
        )!.children![0],
      ).toMatchObject({ disabled: false, detail: "Desk" });
    }
    const held = buildMissionMenuItems([thread(DESK, "held")], hosts, label, allowed);
    expect(held.map((item) => [item.id, item.disabled, item.detail])).toEqual([
      ["mission-start", true, "In a mission"],
      ["mission-leave:env-desk:ffffffffffff", false, undefined],
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

  it("starts a mission from a thread with no messages, and adds one as a member", () => {
    const empty = { ...thread(DESK), latestUserMessageAt: null, visibleItemCount: 0 };
    const items = buildMissionMenuItems([empty], hosts, label, allowed);
    expect(items[0]).toEqual({
      id: "mission-start",
      label: "Start mission from this thread",
      icon: "folder-tree",
      separatorBefore: true,
      disabled: false,
    });
    const add = items.find((item) => item.id === "mission-add")!;
    expect(add.disabled).toBe(false);
    expect(add.children!.every((child) => child.disabled === false)).toBe(true);
    expect(buildMissionMenuItems([empty], hosts, label, () => false)[0]).toMatchObject({
      disabled: true,
      detail: "Not allowed here",
    });
  });

  it("gives a mission's lead the mission's own group, ended once each member is settled", () => {
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
    const group = (members: ReadonlyArray<MissionMember>) =>
      buildMissionMenuItems([thread(DESK, "lead")], led(members), label, allowed).map((item) => [
        item.id,
        item.header ?? item.disabled ?? false,
        item.detail,
      ]);
    expect(group([])).toEqual([
      ["mission-group", true, undefined],
      ["mission-new-thread:env-desk:0123456789ab", false, undefined],
      ["mission-prompt:env-desk:0123456789ab", false, undefined],
      ["mission-delete:env-desk:0123456789ab", false, undefined],
    ]);
    const member = (state: MissionMember["state"]): MissionMember => ({
      ref: { environmentId: LAPTOP, threadId: ThreadId.make("m") },
      role: "member",
      state,
    });
    const here = (threadId: string, extra: Partial<MissionMember> = {}): MissionMember => ({
      ref: { environmentId: DESK, threadId: ThreadId.make(threadId) },
      role: "member",
      state: "active",
      ...extra,
    });
    const end = (members: ReadonlyArray<MissionMember>) => group(members).at(-1)!.slice(1);
    expect(end([here("a", { settled: true }), here("b", { settled: true })])).toEqual([
      false,
      undefined,
    ]);
    expect(end([here("a", { settled: true }), here("b")])).toEqual([true, "Has active threads"]);
    expect(end([here("a", { settled: true, state: "release-pending" })])).toEqual([
      true,
      "Has active threads",
    ]);
    expect(end([here("a", { settled: true }), { ...member("active"), settled: true }])).toEqual([
      true,
      "Has threads on another machine",
    ]);
    expect(end([member("add-pending")])).toEqual([true, "Has threads on another machine"]);
    expect(end([member("release-pending")])).toEqual([true, "Has threads on another machine"]);
    const item = buildMissionMenuItems(
      [thread(DESK, "lead")],
      led([here("a", { settled: true })]),
      label,
      allowed,
    ).at(-1);
    expect(item).toMatchObject({ label: "End mission", icon: "check" });
    expect(item?.destructive).toBeUndefined();
    const barred = buildMissionMenuItems([thread(DESK, "lead")], led([]), label, () => false);
    for (const prefix of ["mission-new-thread:", "mission-prompt:"]) {
      expect(barred.find((item) => item.id.startsWith(prefix))).toMatchObject({
        disabled: true,
        detail: "Not allowed here",
      });
    }
    expect(parseMissionTarget("mission-prompt:env-desk:0123456789ab")?.action).toBe("prompt");
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
      buildMissionMenuItems([thread], hosts, label, can).find((item) =>
        item.id.startsWith("mission-leave:"),
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
      buildMissionMenuItems([thread(LAPTOP, id)], joined, label, can).find(
        (item) => item.label === "Leave mission",
      );
    expect(releaseOf(allowed)).toMatchObject({
      id: "mission-release:env-desk:0123456789ab",
      disabled: false,
    });
    expect(parseMissionTarget(releaseOf(allowed)!.id)).toMatchObject({ action: "release" });
    expect(releaseOf(() => false)).toMatchObject({ disabled: true, detail: "Not allowed here" });
    expect(releaseOf(allowed, "other")).toBeUndefined();
  });

  it("offers one Leave mission, on the member's machine when it may be changed, else the lead's", () => {
    const member = { ref: { environmentId: LAPTOP, threadId: ThreadId.make("ios") } };
    const held: ReadonlyArray<MissionHost> = [
      {
        ...hosts[0]!,
        snapshot: {
          ...hosts[0]!.snapshot,
          missions: [{ ...mission, members: [{ ...member, role: "member", state: "active" }] }],
        },
      },
      {
        environmentId: LAPTOP,
        snapshot: {
          links: [],
          missions: [],
          claims: [
            { threadId: ThreadId.make("ios"), missionId: mission.missionId, name: "Ship v2" },
          ],
        },
      },
    ];
    const ways = (can: (environmentId: EnvironmentId) => boolean) =>
      buildMissionMenuItems([thread(LAPTOP, "ios")], held, label, can).filter(
        (item) => item.icon === "folder-minus",
      );
    expect(ways(allowed)).toEqual([
      expect.objectContaining({
        id: "mission-leave:env-laptop:0123456789ab",
        label: "Leave mission",
        disabled: false,
      }),
    ]);
    expect(ways((environmentId) => environmentId === DESK)).toEqual([
      expect.objectContaining({
        id: "mission-release:env-desk:0123456789ab",
        label: "Leave mission",
        disabled: false,
      }),
    ]);
    expect(ways(() => false)).toEqual([
      expect.objectContaining({
        label: "Leave mission",
        disabled: true,
        detail: "Not allowed here",
      }),
    ]);
  });

  it("leaves directly only the mission the row names, not another the thread's machine holds", () => {
    const ios = { environmentId: LAPTOP, id: ThreadId.make("ios") };
    const movedOn: ReadonlyArray<MissionHost> = [
      {
        environmentId: LAPTOP,
        snapshot: {
          links: [],
          missions: [],
          claims: [{ threadId: ios.id, missionId: "ffffffffffff", name: "Theirs" }],
        },
      },
    ];
    const row = { host: DESK, mission: { missionId: mission.missionId } };
    const meant = mission.missionId;
    expect(missionLeaveId(ios, row, movedOn, allowed, meant)).toBe(
      "mission-release:env-desk:0123456789ab",
    );
    expect(
      missionLeaveId(ios, row, movedOn, (environmentId) => environmentId === LAPTOP, meant),
    ).toBeNull();
    expect(missionLeaveId(ios, undefined, movedOn, allowed, undefined)).toBe(
      "mission-leave:env-laptop:ffffffffffff",
    );
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

describe("claimHere", () => {
  it("answers each snapshot from its own claims, so a new snapshot is never read from an old one", () => {
    const held = thread(DESK, "held");
    expect(claimHere(held, hosts)?.name).toBe("Theirs");
    expect(claimHere(thread(LAPTOP, "held"), hosts)).toBeUndefined();
    expect(claimHere(thread(DESK), hosts)).toBeUndefined();
    const released = hosts.map((host) => ({ ...host, snapshot: { ...host.snapshot, claims: [] } }));
    expect(claimHere(held, released)).toBeUndefined();
    expect(claimHere(held, hosts)?.name).toBe("Theirs");
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
  const live = new Set([environmentId, laptop]);
  const listed = () => groupSidebarMissions(hostOf(ship), threads, null, new Set(), live);
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
    const result = groupSidebarMissions(hostOf(ship, stale, later), shells, null, new Set(), live);
    expect(rowsOf(result)).toEqual([
      ["env-desk:0123456789ab", true, ["docs", "leaving", "refused", "remote"]],
      ["env-desk:aaaaaaaaaaaa", true, ["joining"]],
      ["env-desk:bbbbbbbbbbbb", true, []],
    ]);
    const twice = groupSidebarMissions(hostOf(stale, later), shells, null, new Set(), live);
    expect(rowsOf(twice).map((row) => row[2])).toEqual([["joining"], ["docs"]]);
  });

  it("with a project scope, lists only members in it, under their lead wherever it is", () => {
    const scoped = [...threads, shell("api-docs", { project: "api" })];
    const withApi = mission("0123456789ab", [...ship.members, member("api-docs", "active")]);
    const result = groupSidebarMissions(hostOf(withApi), scoped, new Set(["env-desk:api"]));
    expect(rowsOf(result)).toEqual([["env-desk:0123456789ab", false, ["api-docs"]]]);
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
    const arrived = [...threads, shell("old-lead", { settled: true })];
    expect(rowsOf(groupSidebarMissions(hostOf(waiting), arrived, scope))).toEqual([
      ["env-desk:cccccccccccc", true, []],
    ]);
    expect(
      groupSidebarMissions(hostOf(waiting), arrived, new Set(["env-desk:api"])).missions,
    ).toEqual([]);
  });

  it("hides a settled member the list trimmed, once its machine is done syncing", () => {
    const settled = (
      threadId: string,
      state: MissionMember["state"] = "active",
      role: MissionMember["role"] = "member",
    ): MissionMember => ({ ...member(threadId, state, role), settled: true });
    const trimmed = mission("dddddddddddd", [
      settled("lead", "active", "lead"),
      settled("trimmed"),
      member("loading", "active"),
      settled("leaving", "release-pending"),
      settled("joining", "add-pending"),
      settled("refused", "add-refused"),
      settled("stuck", "release-refused"),
      { ...member("away", "offline", "member", laptop), settled: true },
    ]);
    const shown = (synced: ReadonlySet<EnvironmentId>) =>
      rowsOf(groupSidebarMissions(hostOf(trimmed), [], null, new Set(), synced))[0]![2];
    const kept = ["loading", "leaving", "joining", "refused", "stuck", "away"];
    expect(shown(new Set([environmentId, laptop]))).toEqual(kept);
    expect(shown(new Set())).toEqual(["trimmed", ...kept]);
    const result = groupSidebarMissions(
      hostOf(trimmed),
      [],
      null,
      new Set(),
      new Set([environmentId]),
    );
    expect(result.missions[0]!.lead).toMatchObject({ member: { role: "lead" }, thread: null });
  });

  it("waits for the member's own machine to finish syncing, not any machine", () => {
    const trimmed = mission("dddddddddddd", [
      member("lead", "active", "lead"),
      { ...member("trimmed", "active"), settled: true },
    ]);
    const shown = groupSidebarMissions(hostOf(trimmed), [], null, new Set(), new Set([laptop]));
    expect(rowsOf(shown)[0]![2]).toEqual(["trimmed"]);
  });

  it("keeps a member whose loaded thread is settled while its machine still syncs", () => {
    const resyncing = mission("abababababab", [
      member("lead", "active", "lead"),
      member("cached", "active"),
    ]);
    const shells = [shell("lead"), shell("cached", { settled: true })];
    const rows = (synced: ReadonlySet<EnvironmentId>) =>
      rowsOf(groupSidebarMissions(hostOf(resyncing), shells, null, new Set(), synced))[0]![2];
    expect(rows(new Set([laptop]))).toEqual(["cached"]);
    expect(rows(new Set([environmentId]))).toEqual([]);
  });

  it("keeps an offline or refused-release row even when its loaded thread is settled", () => {
    const stuck = mission("eeeeeeeeeeee", [
      member("lead", "active", "lead"),
      member("away", "offline"),
      member("stuck", "release-refused"),
    ]);
    const shells = [
      shell("lead"),
      shell("away", { settled: true }),
      shell("stuck", { archived: true }),
    ];
    const result = groupSidebarMissions(
      hostOf(stuck),
      shells,
      null,
      new Set(),
      new Set([environmentId]),
    );
    expect(rowsOf(result)[0]![2]).toEqual(["away", "stuck"]);
  });

  it("hides a trimmed member another machine marks settled, while it still blocks ending", () => {
    const remote = member("remote", "active", "member", laptop);
    const led = mission("ffffffffffff", [member("lead", "active", "lead"), remote]);
    const hosts = (claim: { readonly missionId: string; readonly settled?: true }) => [
      ...hostOf(led),
      {
        environmentId: laptop,
        snapshot: {
          links: [],
          missions: [],
          claims: [{ threadId: ThreadId.make("remote"), name: "x", ...claim }],
        },
      },
    ];
    const members = (
      claim: Parameters<typeof hosts>[0],
      synced: ReadonlySet<EnvironmentId> = new Set([environmentId, laptop]),
    ) => rowsOf(groupSidebarMissions(hosts(claim), [], null, new Set(), synced))[0]![2];
    expect(members({ missionId: "ffffffffffff", settled: true })).toEqual([]);
    expect(members({ missionId: "ffffffffffff" })).toEqual(["remote"]);
    expect(members({ missionId: "aaaaaaaaaaaa", settled: true })).toEqual(["remote"]);
    expect(members({ missionId: "ffffffffffff", settled: true }, new Set([environmentId]))).toEqual(
      ["remote"],
    );
    const end = missionRowItems({
      host: environmentId,
      mission: led,
      leadGone: false,
      canChange: true,
    }).at(-1);
    expect(end).toMatchObject({ disabled: true, detail: "Has threads on another machine" });
  });

  it("leaves every thread to the other lists when no mission is listed", () => {
    expect(groupSidebarMissions([], threads, null)).toEqual({
      missions: [],
      threadKeys: new Set(),
      leads: [],
    });
  });
});

describe("missionDraftMachines", () => {
  const joins = { host: DESK, missionId: mission.missionId, name: mission.name };

  it("keeps a new lead on its mission's machine, even when that machine links to others", () => {
    const lead = { kind: "lead", ...joins, expectedLead: ThreadId.make("gone") } as const;
    expect(missionDraftMachines(lead, hosts)).toEqual(new Set([DESK]));
  });

  it("lets a member use machines its mission's machine links to with full access", () => {
    expect(missionDraftMachines({ kind: "member", ...joins }, hosts)).toEqual(
      new Set([DESK, LAPTOP]),
    );
  });

  it("leaves a member any machine when this session may not see the links", () => {
    const hidden: ReadonlyArray<MissionHost> = hosts.map((host) => ({
      ...host,
      snapshot: { ...host.snapshot, links: [], linksHidden: true },
    }));
    expect(missionDraftMachines({ kind: "member", ...joins }, hidden)).toBeNull();
  });
});

describe("missionsLiveKey", () => {
  const descriptors: ReadonlyMap<
    EnvironmentId,
    Pick<ExecutionEnvironmentDescriptor, "capabilities">
  > = new Map([
    [DESK, { capabilities: { repositoryIdentity: true, missions: true } }],
    [LAPTOP, { capabilities: { repositoryIdentity: true } }],
  ]);
  const key = (enabled: boolean, readable: ReadonlyArray<EnvironmentId>) =>
    JSON.parse(
      missionsLiveKey({
        enabled,
        connected: [DESK, LAPTOP, BOX],
        readable: new Set(readable),
        descriptorOf: (environmentId) => descriptors.get(environmentId),
      }),
    );

  it("asks each readable server with a known config, omitting prompts only where it says it can", () => {
    expect(key(true, [DESK, LAPTOP, BOX])).toEqual([
      [DESK, true],
      [LAPTOP, false],
    ]);
  });

  it("asks no server this session may not read, and none while Missions are off", () => {
    expect(key(true, [LAPTOP])).toEqual([[LAPTOP, false]]);
    expect(key(false, [DESK, LAPTOP])).toEqual([]);
  });
});

describe("missionLeadCandidates", () => {
  const candidate = (id: string, latestUserMessageAt: string, archived = false) => ({
    ...thread(DESK, id),
    latestUserMessageAt,
    title: id,
    archivedAt: archived ? "2026-11-24T00:00:00.000Z" : null,
  });

  it("offers the mission's machine's live threads with messages, the most recent first", () => {
    const candidates = missionLeadCandidates(
      [
        candidate("older", "2026-11-20T00:00:00.000Z"),
        candidate("archived", "2026-11-25T00:00:00.000Z", true),
        candidate("newer", "2026-11-24T00:00:00.000Z"),
      ],
      { host: DESK, missionId: mission.missionId },
      hosts,
    );
    expect(candidates.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("withoutQuietMissionUpdates", () => {
  const at = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
  const LEAD = ThreadId.make("lead");
  type Item = OrchestrationV2TurnItem;
  const wakeId = (run: string) => `turn-item:message:message%3Amission-update%3Am1%3A${run}`;
  const base = (run: string, id: string) => ({
    id: TurnItemId.make(`${run}:${id}`),
    threadId: LEAD,
    runId: RunId.make(run),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  });
  const wake = (run: string, id = wakeId(run), summary = "Mission update"): Item => ({
    ...base(run, "wake"),
    id: TurnItemId.make(id),
    type: "notification",
    source: { kind: "system" },
    outcome: "updated",
    summary,
    detail: "Mission update: member 1 is awaiting input.",
  });
  const tool = (run: string, toolName: string, status: Item["status"] = "completed"): Item => ({
    ...base(run, toolName),
    status,
    type: "dynamic_tool",
    toolName,
    input: {},
  });
  const script = (run: string, code: string): Item => ({
    ...base(run, "execute"),
    type: "dynamic_tool",
    toolName: "execute",
    input: { code },
  });
  const NAMESPACE = `tools["t3-code-af84a96a-cb76-409a-851b-c0fb0d783eb2"]`;
  const READ_SCRIPT = [
    `const t = ${NAMESPACE};`,
    `const r = await t.t3_thread_read({threadId: "mcp:launch:member", limit: 2, runLimit: 1, maxCharsPerItem: 3000});`,
    "return {status: r.thread.status, items: r.items.map(i => i.text)};",
  ].join("\n");
  const MULTI_READ_SCRIPT = [
    'const ns = tools["t3-code-5f32a1"]; const out={};',
    'for (const id of ["mcp:a","mcp:b"]) { const r = await ns.t3_thread_read({threadId:id, limit:2}); out[id]=(r.items||[]).map(x=>`[${x.type}] ${x.text||""}`);}',
    "return out;",
  ].join("\n");
  const reply = (run: string, text: string): Item => ({
    ...base(run, `reply-${text}`),
    type: "assistant_message",
    messageId: MessageId.make(`${run}:reply-${text}`),
    text,
    streaming: false,
  });
  const thought = (run: string): Item => ({
    ...base(run, "thought"),
    type: "reasoning",
    text: "Checking the member.",
    streaming: false,
  });
  const user = (run: string, inputIntent: "turn_start" | "steer" = "turn_start"): Item => ({
    ...base(run, `user-${inputIntent}`),
    type: "user_message",
    messageId: MessageId.make(`${run}:user-${inputIntent}`),
    createdBy: "user",
    creationSource: "web",
    inputIntent,
    text: "How is it going?",
    attachments: [],
  });
  const question = (run: string): Item => ({
    ...base(run, "question"),
    status: "waiting",
    type: "user_input_request",
    requestId: "question" as never,
    questions: [],
  });
  const rows = (items: ReadonlyArray<Item>): Array<OrchestrationV2ProjectedTurnItem> =>
    items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: LEAD,
      sourceItemId: item.id,
      item,
    }));
  type RunStatus = OrchestrationV2Run["status"];
  type AttemptStatus = OrchestrationV2RunAttempt["status"];
  const runOf = (run: string, status: RunStatus) => ({ id: RunId.make(run), status });
  const attempt = (run: string, status: AttemptStatus, attemptOrdinal = 1) => ({
    runId: RunId.make(run),
    attemptOrdinal,
    status,
  });
  const finished = (...runIds: ReadonlyArray<string>) => ({
    runs: runIds.map((run) => runOf(run, "completed")),
    attempts: runIds.map((run) => attempt(run, "completed")),
  });
  const hide = (
    items: ReadonlyArray<Item>,
    status: {
      readonly runs?: ReadonlyArray<ReturnType<typeof runOf>>;
      readonly attempts?: ReadonlyArray<ReturnType<typeof attempt>>;
    } = {},
  ) => {
    const thread = rows(items);
    return { thread, shown: withoutQuietMissionUpdates(thread, status.runs, status.attempts) };
  };
  const quietRun = (run: string) => [
    wake(run),
    thought(run),
    tool(run, "mcp__t3-code__t3_thread_read"),
    tool(run, "t3_mission_roster"),
    reply(run, "  "),
  ];

  it("hides finished wakes that only read and wrote nothing, and keeps the turns around them", () => {
    const { runs, attempts } = finished("asked", "quiet-1", "quiet-2", "quiet-3", "spoke");
    const { shown } = hide(
      [
        user("asked"),
        reply("asked", "Started the mission."),
        ...quietRun("quiet-1"),
        wake("quiet-2"),
        thought("quiet-2"),
        ...quietRun("quiet-3"),
        wake("spoke"),
        reply("spoke", "Member 1 needs your answer."),
      ],
      { runs, attempts: [...attempts, attempt("quiet-3", "failed", 0)] },
    );
    expect(shown.map(({ item }) => item.id)).toEqual([
      "asked:user-turn_start",
      "asked:reply-Started the mission.",
      wakeId("spoke"),
      "spoke:reply-Member 1 needs your answer.",
    ]);
  });

  it.each([
    ["thought and wrote nothing", [wake("q"), thought("q"), reply("q", "")]],
    [
      "read and replied with the quiet marker",
      [wake("q"), tool("q", "t3_thread_read"), reply("q", ` ${MISSION_QUIET_REPLY}\n`)],
    ],
    ["ran a Code Mode script that read", [wake("q"), script("q", READ_SCRIPT)]],
    ["ran a Code Mode script that read in a loop", [wake("q"), script("q", MULTI_READ_SCRIPT)]],
  ] as const)("hides a finished wake that %s", (_case, items) => {
    expect(hide(items, finished("q")).shown).toEqual([]);
  });

  const DONE = finished("run");
  it.each([
    ["it wrote a reply", [wake("run"), reply("run", "Nothing needs you.")], DONE],
    [
      "its reply adds to the marker",
      [wake("run"), reply("run", "No change. Member 1 waits.")],
      DONE,
    ],
    ["its marker has the wrong case", [wake("run"), reply("run", "no change.")], DONE],
    [
      "one of its replies is not the marker",
      [wake("run"), reply("run", ""), reply("run", "Hi")],
      DONE,
    ],
    ["it acted", [wake("run"), tool("run", "mcp__t3-code__t3_thread_send")], DONE],
    ["it ran a tool it cannot name", [wake("run"), tool("run", "Shell")], DONE],
    ["a read failed", [wake("run"), tool("run", "t3_thread_read", "failed")], DONE],
    ["it asks a question", [wake("run"), question("run")], DONE],
    ["the user steered it", [wake("run"), user("run", "steer")], DONE],
    [
      "it is running",
      [wake("run")],
      { runs: [runOf("run", "running")], attempts: [attempt("run", "running")] },
    ],
    [
      "its run is still open after its attempt completed",
      [wake("run")],
      { runs: [runOf("run", "running")], attempts: [attempt("run", "completed")] },
    ],
    [
      "it failed",
      [wake("run")],
      { runs: [runOf("run", "failed")], attempts: [attempt("run", "failed")] },
    ],
    [
      "it was interrupted",
      [wake("run")],
      { runs: [runOf("run", "interrupted")], attempts: [attempt("run", "interrupted")] },
    ],
    ["its run is unknown", [wake("run")], { attempts: DONE.attempts }],
    ["its attempts are unknown", [wake("run")], { runs: DONE.runs }],
    ["it was no wake", [user("run")], DONE],
    ["only its conversation items are loaded", [wake("run"), reply("run", "")], DONE],
    [
      "only its conversation items are loaded and it said the marker",
      [wake("run"), reply("run", MISSION_QUIET_REPLY)],
      DONE,
    ],
    [
      "its script spells tools with an escape",
      [
        wake("run"),
        script("run", `${READ_SCRIPT}\nawait \\u0074ools.opencode.worktree_remove({});`),
      ],
      DONE,
    ],
    [
      "its script sends through a spaced namespace",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait tools ["t3-code-x"].t3_thread_send({});`)],
      DONE,
    ],
    [
      "its script picks a send by a spaced computed key",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait t ["t3_thread_send"]({});`)],
      DONE,
    ],
    ["its notification is not a mission wake", [wake("run", "turn-item:message:other")], DONE],
    ["it was a resumed thread", [wake("run", wakeId("run"), "Resumed thread")], DONE],
    [
      "its script sends",
      [
        wake("run"),
        script("run", `await ${NAMESPACE}.t3_thread_send({threadId: "m", text: "go"});`),
      ],
      DONE,
    ],
    [
      "its script reads and launches",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait t.t3_thread_launch({});`)],
      DONE,
    ],
    [
      "its script reads and sends feedback",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait t.t3_feedback({});`)],
      DONE,
    ],
    [
      "its script destructures a tool",
      [wake("run"), script("run", `${READ_SCRIPT}\nconst { t3_thread_send } = t;`)],
      DONE,
    ],
    [
      "its script hands the namespace to a function",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait helper(t);`)],
      DONE,
    ],
    [
      "its script builds a tool name after a read",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait t["t3_thread_" + "send"]({});`)],
      DONE,
    ],
    [
      "its script reaches OpenCode",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait tools.opencode.worktree_list();`)],
      DONE,
    ],
    [
      "its script picks a tool by a computed key",
      [wake("run"), script("run", `const k = "t3-code-x";\nawait tools[k].t3_thread_read({});`)],
      DONE,
    ],
    [
      "its script fetches",
      [wake("run"), script("run", `${READ_SCRIPT}\nawait fetch("https://example.com");`)],
      DONE,
    ],
    ["its script calls no T3 tool", [wake("run"), script("run", "return 1 + 1;")], DONE],
  ] as const)("shows a mission update when %s", (_case, items, status) => {
    const { thread, shown } = hide(items, status);
    expect(shown).toBe(thread);
  });

  it("returns the same rows for the same inputs, so a render does not loop", () => {
    const thread = rows(quietRun("quiet"));
    const { runs, attempts } = finished("quiet");
    const shown = withoutQuietMissionUpdates(thread, runs, attempts);
    expect(shown).toEqual([]);
    expect(withoutQuietMissionUpdates(thread, runs, attempts)).toBe(shown);
    expect(quietMissionUpdateRunIds(thread, runs, attempts)).toEqual(new Set(["quiet"]));
  });
});
