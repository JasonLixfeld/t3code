import type { MissionHost } from "@t3tools/client-runtime/missions";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
  const permission = () => {
    const byHost = Atom.family((_environmentId: string) => Atom.make(true).pipe(Atom.keepAlive));
    return { permissionAtom: byHost };
  };
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([["env-desk", { environment: { capabilities: { missions: true } } }]]),
    ),
    serverEnvironment: {
      missionsLiveAcross: () => hosts,
      createMission: permission(),
      addMissionMember: permission(),
      setMissionLead: permission(),
    },
  };
});

const hostsAtom = serverEnvironment.missionsLiveAcross("") as unknown as Atom.Writable<
  ReadonlyArray<MissionHost>
>;
const host = (snapshot: Partial<MissionHost["snapshot"]>): ReadonlyArray<MissionHost> => [
  { environmentId: DESK, snapshot: { missions: [], claims: [], links: [], ...snapshot } },
];
const allow = (command: { permissionAtom: (host: EnvironmentId) => unknown }, allowed: boolean) =>
  appAtomRegistry.set(command.permissionAtom(DESK) as Atom.Writable<boolean>, allowed);
const member = { kind: "member" as const, host: DESK, missionId: "m1", name: "Ship v2" };
const lead = { ...member, kind: "lead" as const, expectedLead: ThreadId.make("gone") };
const send = (intent: Parameters<typeof readMissionDraftSend>[0], environmentId = DESK) =>
  readMissionDraftSend(intent, environmentId).kind;

it("checks a send against the mission state and the mission action's permission at send time", () => {
  expect(send(member)).toBe("offline");

  appAtomRegistry.set(
    hostsAtom,
    host({ links: [{ environmentId: LAPTOP, label: "Laptop", fullAccess: true }] }),
  );
  expect(send(member, LAPTOP)).toBe("mission");

  allow(serverEnvironment.addMissionMember, false);
  expect(send(member, LAPTOP)).toBe("not-allowed");
  expect(send(lead)).toBe("mission");
  allow(serverEnvironment.setMissionLead, false);
  expect(send(lead)).toBe("not-allowed");
  allow(serverEnvironment.addMissionMember, true);

  appAtomRegistry.set(hostsAtom, host({ linksHidden: true }));
  expect(send(member, LAPTOP)).toBe("machine-refused");
  expect(send(member)).toBe("mission");

  appAtomRegistry.set(
    mobilePreferencesAtom as unknown as Atom.Writable<AsyncResult.AsyncResult<object>>,
    AsyncResult.success({ missionsEnabled: false }),
  );
  expect(send(member, LAPTOP)).toBe("turned-off");
  expect(send(undefined, LAPTOP)).toBe("plain");
});
