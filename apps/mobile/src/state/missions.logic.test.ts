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

  it("keeps a marked draft to a start machine, or to a member's host and its full-access links", () => {
    const allowed = (intent: Parameters<typeof machines>[0]) =>
      [DESK, LAPTOP, PHONE].filter((id) => missionDraftAllows(machines(intent), id));
    expect(allowed(undefined)).toEqual([DESK, LAPTOP, PHONE]);
    expect(machines({ kind: "new" })).toBe(startMachines);
    expect(allowed(member)).toEqual([DESK, LAPTOP]);
  });

  const hidden: ReadonlyArray<MissionHost> = hosts.map((host) => ({
    ...host,
    snapshot: { ...host.snapshot, links: [], linksHidden: true as const },
  }));
  it.each([
    [
      "a plain draft while Missions are off",
      PHONE,
      { intent: undefined, missionsOff: true },
      "plain",
    ],
    ["a marked draft while Missions are off", PHONE, { missionsOff: true }, "turned-off"],
    ["a member on a full-access link", LAPTOP, {}, "mission"],
    ["a member on a link without full access", PHONE, {}, "machine-refused"],
    ["a member on its host while links are hidden", DESK, { hosts: hidden }, "mission"],
    ["a member on a link while links are hidden", LAPTOP, { hosts: hidden }, "machine-refused"],
    ["a member while its host is offline", DESK, { hosts: [] }, "offline"],
    [
      "a new mission while its machine is offline",
      DESK,
      { intent: { kind: "new" }, hosts: [] },
      "offline",
    ],
    ["a member where adding is not allowed", DESK, { allowed: false }, "not-allowed"],
    ["a lead where leading is not allowed", DESK, { intent: lead, allowed: false }, "not-allowed"],
    ["a lead on its host", DESK, { intent: lead }, "mission"],
  ] as const)("checks the send of %s", (_name, environmentId, input, expected) => {
    expect(send(environmentId, input)).toBe(expected);
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
