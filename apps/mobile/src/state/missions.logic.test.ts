import { EnvironmentId, type ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MissionHost } from "@t3tools/client-runtime/missions";

import {
  canStartMission,
  missionDraftProjectMachines,
  missionsAdvertised,
  resolveMissionPreferences,
} from "./missions.logic";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const configs = (
  entries: ReadonlyArray<[EnvironmentId, Partial<ExecutionEnvironmentCapabilities>]>,
) =>
  new Map(
    entries.map(([environmentId, capabilities]) => [
      environmentId,
      { environment: { capabilities } } as never,
    ]),
  );

describe("missionsAdvertised", () => {
  it("offers Missions only when a connected server says it serves them", () => {
    const listed = configs([
      [DESK, { missions: true }],
      [LAPTOP, {}],
    ]);
    expect(missionsAdvertised([DESK, LAPTOP], listed)).toBe(true);
    expect(missionsAdvertised([LAPTOP], listed)).toBe(false);
    expect(missionsAdvertised([], listed)).toBe(false);
  });
});

describe("resolveMissionPreferences", () => {
  it("turns Missions and both headings on until the user turns them off", () => {
    expect(resolveMissionPreferences({})).toEqual({
      loaded: true,
      enabled: true,
      headerVisible: true,
      threadsHeaderVisible: true,
    });
    expect(
      resolveMissionPreferences({
        missionsEnabled: false,
        missionsHeaderVisible: false,
        threadsHeaderVisible: false,
      }),
    ).toMatchObject({ enabled: false, headerVisible: false, threadsHeaderVisible: false });
    expect(resolveMissionPreferences(null).loaded).toBe(false);
  });
});

describe("a new mission's machines", () => {
  const PHONE = EnvironmentId.make("env-phone");
  const hosts: ReadonlyArray<MissionHost> = [
    {
      environmentId: DESK,
      snapshot: {
        missions: [],
        claims: [],
        links: [
          { environmentId: LAPTOP, label: "Laptop", fullAccess: true },
          { environmentId: PHONE, label: "Phone", fullAccess: false },
        ],
      },
    },
  ];
  const member = { kind: "member", host: DESK, missionId: "m1", name: "Ship v2" } as const;

  it("starts a new mission on a machine that may start one, and a member on its host or a full-access link", () => {
    const start = new Set([DESK]);
    expect(missionDraftProjectMachines(undefined, hosts, start)).toBeNull();
    expect(missionDraftProjectMachines({ kind: "new" }, hosts, start)).toBe(start);
    expect(missionDraftProjectMachines(member, hosts, start)).toEqual(new Set([DESK, LAPTOP]));
  });

  it("offers New mission only where a start machine has a project or a No project home", () => {
    const project = { environmentId: DESK, workspaceRoot: "/work/app", archivedAt: null };
    const noScratch = () => null;
    expect(canStartMission(new Set(), [project], noScratch)).toBe(false);
    expect(canStartMission(new Set([DESK]), [project], noScratch)).toBe(true);
    expect(
      canStartMission(
        new Set([DESK]),
        [{ ...project, archivedAt: "2026-11-01T00:00:00.000Z" }],
        noScratch,
      ),
    ).toBe(false);
    expect(canStartMission(new Set([DESK]), [], () => "/scratch")).toBe(true);
  });
});
