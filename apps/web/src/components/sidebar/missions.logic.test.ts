import { EnvironmentId, type Mission, type MissionLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMissionMenuItems, type MissionHost, parseMissionAddId } from "./missions.logic";

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
  { environmentId: DESK, snapshot: { missions: [mission], links } },
];
const label = (environmentId: EnvironmentId) =>
  environmentId === DESK ? "Desk" : String(environmentId);

const addChild = (threads: Parameters<typeof buildMissionMenuItems>[0]) =>
  buildMissionMenuItems(threads, hosts, label).find((item) => item.id === "mission-add")!
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
    const [start, add] = buildMissionMenuItems(
      [{ environmentId: DESK, tags: ["mission:abc:Other"] }],
      hosts,
      label,
    );
    expect([start, add].map((item) => [item!.id, item!.disabled, item!.detail])).toEqual([
      ["mission-start", true, "In a mission"],
      ["mission-add", true, "In a mission"],
    ]);
  });

  it("starts missions only for one thread on a machine that runs them", () => {
    expect(buildMissionMenuItems([{ environmentId: DESK }], hosts, label)[0]).toMatchObject({
      id: "mission-start",
      disabled: false,
    });
    expect(buildMissionMenuItems([{ environmentId: LAPTOP }], hosts, label)[0]).toMatchObject({
      id: "mission-start",
      disabled: true,
    });
    expect(
      buildMissionMenuItems([{ environmentId: DESK }, { environmentId: DESK }], hosts, label).map(
        (item) => item.id,
      ),
    ).toEqual(["mission-add"]);
  });

  it("reads the host and mission back from an add entry", () => {
    expect(parseMissionAddId("mission-add:env:with:colons:0123456789ab")).toEqual({
      environmentId: "env:with:colons",
      missionId: "0123456789ab",
    });
  });
});
