import type { MissionHost } from "@t3tools/client-runtime/missions";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { readMissionDraftSend } from "./missions";
import { mobilePreferencesAtom } from "./preferences";
import { serverEnvironment } from "./server";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");

vi.mock("./preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})).pipe(Atom.keepAlive) };
});
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { connectedEnvironmentIdsAtom: Atom.make(["env-desk"]) };
});
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSession: { sessionStateAtom: () => Atom.make(null) },
    sessionHasScope: () => true,
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const hosts = Atom.make<ReadonlyArray<unknown>>([]).pipe(Atom.keepAlive);
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([["env-desk", { environment: { capabilities: { missions: true } } }]]),
    ),
    serverEnvironment: {
      missionsLiveAcross: () => hosts,
      createMission: { permissionAtom: () => Atom.make(true) },
    },
  };
});

const hostsAtom = serverEnvironment.missionsLiveAcross("") as unknown as Atom.Writable<
  ReadonlyArray<MissionHost>
>;
const host = (snapshot: Partial<MissionHost["snapshot"]>): ReadonlyArray<MissionHost> => [
  { environmentId: DESK, snapshot: { missions: [], claims: [], links: [], ...snapshot } },
];
const member = { kind: "member" as const, host: DESK, missionId: "m1", name: "Ship v2" };

it("checks a send against the mission state at send time", () => {
  appAtomRegistry.set(
    hostsAtom,
    host({ links: [{ environmentId: LAPTOP, label: "Laptop", fullAccess: true }] }),
  );
  expect(readMissionDraftSend(member, LAPTOP)).toBe("mission");

  appAtomRegistry.set(hostsAtom, host({ linksHidden: true }));
  expect(readMissionDraftSend(member, LAPTOP)).toBe("refused");
  expect(readMissionDraftSend(member, DESK)).toBe("mission");

  appAtomRegistry.set(
    mobilePreferencesAtom as unknown as Atom.Writable<AsyncResult.AsyncResult<object>>,
    AsyncResult.success({ missionsEnabled: false }),
  );
  expect(readMissionDraftSend(member, LAPTOP)).toBe("drop");
  expect(readMissionDraftSend(undefined, LAPTOP)).toBe("plain");
});
