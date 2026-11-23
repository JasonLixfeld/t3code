import { EnvironmentId, type Mission, type MissionLink, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addEachToMission,
  buildMissionMenuItems,
  missionAddSummary,
  type MissionHost,
  parseMissionAddId,
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

const addChild = (threads: Parameters<typeof buildMissionMenuItems>[0]) =>
  buildMissionMenuItems(threads, hosts, label, allowed).find((item) => item.id === "mission-add")!
    .children![0]!;

describe("buildMissionMenuItems", () => {
  it("offers a mission to threads on its machine and behind a full-access link", () => {
    expect(addChild([{ environmentId: DESK }, { environmentId: LAPTOP }])).toEqual({
      id: "mission-add:env-desk:0123456789ab",
      label: "Ship v2",
      disabled: false,
      detail: "Desk",
    });
  });

  it("says why a thread cannot join", () => {
    expect(addChild([{ environmentId: BOX }])).toMatchObject({
      disabled: true,
      detail: "Needs full-access link",
    });
    expect(addChild([{ environmentId: OTHER }])).toMatchObject({
      disabled: true,
      detail: "No link from Desk",
    });
    // The claim its own machine holds decides, not a tag the thread carries.
    const held = buildMissionMenuItems(
      [{ environmentId: DESK, id: ThreadId.make("held") }],
      hosts,
      label,
      allowed,
    );
    expect(held.map((item) => [item.id, item.disabled, item.detail])).toEqual([
      ["mission-start", true, "In a mission"],
      ["mission-leave", false, undefined],
      ["mission-add", true, "In a mission"],
    ]);
  });

  it("starts missions only for one thread on a machine that runs them", () => {
    expect(
      buildMissionMenuItems([{ environmentId: DESK }], hosts, label, allowed)[0],
    ).toMatchObject({
      id: "mission-start",
      disabled: false,
    });
    expect(
      buildMissionMenuItems([{ environmentId: LAPTOP }], hosts, label, allowed)[0],
    ).toMatchObject({
      id: "mission-start",
      disabled: true,
    });
    expect(
      buildMissionMenuItems(
        [{ environmentId: DESK }, { environmentId: DESK }],
        hosts,
        label,
        allowed,
      ).map((item) => item.id),
    ).toEqual(["mission-add"]);
  });

  it("refuses single and bulk adds alike where this client may not change missions", () => {
    const nowhere = () => false;
    for (const threads of [
      [{ environmentId: DESK }],
      [{ environmentId: DESK }, { environmentId: LAPTOP }],
    ]) {
      const items = buildMissionMenuItems(threads, hosts, label, nowhere);
      const add = items.find((item) => item.id === "mission-add")!;
      expect(add.children![0]).toMatchObject({ disabled: true, detail: "Not allowed here" });
    }
    expect(
      buildMissionMenuItems([{ environmentId: DESK }], hosts, label, nowhere)[0],
    ).toMatchObject({ id: "mission-start", disabled: true, detail: "Not allowed here" });
  });

  it("offers leaving only for a thread its own machine holds in a mission", () => {
    const leaveOf = (thread: Parameters<typeof buildMissionMenuItems>[0][number], can = allowed) =>
      buildMissionMenuItems([thread], hosts, label, can).find(
        (item) => item.id === "mission-leave",
      );
    expect(leaveOf({ environmentId: DESK, id: ThreadId.make("held") })).toMatchObject({
      label: "Leave mission",
      disabled: false,
    });
    expect(leaveOf({ environmentId: DESK, id: ThreadId.make("free") })).toBeUndefined();
    expect(leaveOf({ environmentId: LAPTOP, id: ThreadId.make("held") })).toBeUndefined();
    expect(leaveOf({ environmentId: DESK, id: ThreadId.make("held") }, () => false)).toMatchObject({
      disabled: true,
      detail: "Not allowed here",
    });
  });

  it("reads the host and mission back from an add entry", () => {
    expect(parseMissionAddId("mission-add:env:with:colons:0123456789ab")).toEqual({
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
