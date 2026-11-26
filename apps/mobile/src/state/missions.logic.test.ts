import { EnvironmentId, type ExecutionEnvironmentCapabilities, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type MissionHost, missionsLiveKey } from "@t3tools/client-runtime/missions";

import {
  canStartMission,
  missionAdvertisers,
  missionDraftAllows,
  missionDraftProjectMachines,
  missionDraftSend,
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

describe("missionAdvertisers", () => {
  it("keeps only connected servers that say they serve Missions, so an older fork server's are hidden", () => {
    const listed = configs([
      [DESK, { missions: true }],
      [LAPTOP, {}],
    ]);
    expect(missionAdvertisers([DESK, LAPTOP], listed)).toEqual([DESK]);
    expect(missionAdvertisers([LAPTOP], listed)).toEqual([]);
    expect(
      missionsLiveKey({
        enabled: true,
        connected: missionAdvertisers([DESK, LAPTOP], listed),
        readable: new Set([DESK, LAPTOP]),
        descriptorOf: () => ({ capabilities: { repositoryIdentity: true, missions: true } }),
      }),
    ).toBe(JSON.stringify([[DESK, true]]));
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

  const startMachines = new Set([DESK]);
  const machines = (intent: Parameters<typeof missionDraftProjectMachines>[0]["intent"]) =>
    missionDraftProjectMachines({ intent, missionsOff: false, hosts, startMachines });
  const lead = { ...member, kind: "lead", expectedLead: ThreadId.make("gone") } as const;
  const send = (
    environmentId: EnvironmentId,
    input: {
      intent?: Parameters<typeof missionDraftSend>[0]["intent"];
      missionsOff?: boolean;
      hosts?: ReadonlyArray<MissionHost>;
      allowed?: boolean;
    } = {},
  ) =>
    missionDraftSend({
      intent: "intent" in input ? input.intent : member,
      missionsOff: input.missionsOff ?? false,
      hosts: input.hosts ?? hosts,
      environmentId,
      canRun: () => input.allowed ?? true,
    }).kind;

  it("starts a new mission on a machine that may start one, and a member on its host or a full-access link", () => {
    expect(machines(undefined)).toBeNull();
    expect(machines({ kind: "new" })).toBe(startMachines);
    expect(machines(member)).toEqual(new Set([DESK, LAPTOP]));
  });

  it("sends as a plain thread only when the user turned Missions off, and keeps a member to its host when links are hidden", () => {
    expect(send(PHONE, { intent: undefined, missionsOff: true })).toBe("plain");
    expect(send(PHONE, { missionsOff: true })).toBe("turned-off");
    expect(send(LAPTOP)).toBe("mission");
    expect(send(PHONE)).toBe("machine-refused");

    const hidden: ReadonlyArray<MissionHost> = hosts.map((host) => ({
      ...host,
      snapshot: { ...host.snapshot, links: [], linksHidden: true as const },
    }));
    expect(send(DESK, { hosts: hidden })).toBe("mission");
    expect(send(LAPTOP, { hosts: hidden })).toBe("machine-refused");
  });

  it("refuses a send while the mission's machine is offline or loading, or the action is not allowed there", () => {
    expect(send(DESK, { hosts: [] })).toBe("offline");
    expect(send(DESK, { intent: { kind: "new" }, hosts: [] })).toBe("offline");
    expect(send(DESK, { allowed: false })).toBe("not-allowed");
    expect(send(DESK, { intent: lead, allowed: false })).toBe("not-allowed");
    expect(send(DESK, { intent: lead })).toBe("mission");
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

describe("missionDraftAllows", () => {
  it("keeps a marked draft's environments and its send to the machines its mission allows", () => {
    const environments = [DESK, LAPTOP];
    const machines = new Set([DESK]);
    expect(environments.filter((id) => missionDraftAllows(machines, id))).toEqual([DESK]);
    expect(missionDraftAllows(machines, LAPTOP)).toBe(false);
    expect(environments.filter((id) => missionDraftAllows(null, id))).toEqual(environments);
  });
});
