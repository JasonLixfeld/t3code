import { EnvironmentId, type ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { missionsAdvertised, resolveMissionPreferences } from "./missions.logic";

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
