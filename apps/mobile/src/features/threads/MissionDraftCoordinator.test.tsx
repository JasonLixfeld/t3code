import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  markMissionDraft,
  missionDraftOf,
  settleMissionDraftAttempt,
  startMissionDraftAttempt,
} from "../../state/mission-drafts";
import { environmentShell } from "../../state/shell";
import { MissionDraftCoordinator } from "./MissionDraftCoordinator";

const createMission = vi.hoisted(() => vi.fn());
const sentThreads = vi.hoisted(() => new Set<string>());
const reportMissionFailure = vi.hoisted(() => vi.fn());
const missions = vi.hoisted(() => ({ turnedOff: false }));

vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentShell: {
      stateValueAtom: Atom.family((_environmentId: string) =>
        Atom.make({ removedAt: new Map<string, number>() }).pipe(Atom.keepAlive),
      ),
    },
  };
});
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string }) =>
    sentThreads.has(ref.threadId)
      ? { latestUserMessageAt: "2026-11-26", visibleItemCount: 1 }
      : null,
}));
vi.mock("../../state/missions", () => {
  const noHosts: ReadonlyArray<never> = [];
  return { useMissionHosts: () => noHosts, useMissionsTurnedOff: () => missions.turnedOff };
});
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => createMission }));
vi.mock("./useMissionActions", () => ({
  reportLeadOutcome: vi.fn(),
  reportMissionFailure,
}));

it("keeps a waiting or failed mark while its thread is not delivered, and clears it once the thread is removed", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const environmentId = EnvironmentId.make("env-desk");
  const thread = { environmentId, threadId: ThreadId.make("t1") };
  const failed = { environmentId, threadId: ThreadId.make("t2") };
  markMissionDraft(thread, { kind: "new" }, () => "m1");
  markMissionDraft(failed, { kind: "new" }, () => "m2");
  settleMissionDraftAttempt(failed, startMissionDraftAttempt(failed), "failed");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MissionDraftCoordinator />
      </RegistryContext.Provider>,
    ),
  );
  expect(missionDraftOf(thread)?.step).toBe("waiting");
  expect(missionDraftOf(failed)?.step).toBe("failed");
  expect(createMission).not.toHaveBeenCalled();

  act(() =>
    appAtomRegistry.set(
      environmentShell.stateValueAtom(environmentId) as unknown as Atom.Writable<{
        removedAt: ReadonlyMap<string, number>;
      }>,
      {
        removedAt: new Map([
          [thread.threadId, 2],
          [failed.threadId, 3],
        ]),
      },
    ),
  );
  expect(missionDraftOf(thread)).toBeUndefined();
  expect(missionDraftOf(failed)).toBeUndefined();
  expect(createMission).not.toHaveBeenCalled();
});

it("drops the late failure of an attempt whose mark was replaced, without an alert", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const thread = { environmentId: EnvironmentId.make("env-box"), threadId: ThreadId.make("t3") };
  let fail: (result: unknown) => void = () => {};
  createMission.mockImplementationOnce(() => new Promise((resolve) => (fail = resolve)));
  sentThreads.add(thread.threadId);
  markMissionDraft(thread, { kind: "new" }, () => "m3");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MissionDraftCoordinator />
      </RegistryContext.Provider>,
    ),
  );
  expect(missionDraftOf(thread)?.step).toBe("trying");

  sentThreads.delete(thread.threadId);
  act(() => markMissionDraft(thread, { kind: "new" }, () => "m4"));
  await act(async () => fail({ _tag: "Failure" }));
  expect(reportMissionFailure).not.toHaveBeenCalled();
  expect(missionDraftOf(thread)).toMatchObject({ missionId: "m4", step: "waiting" });
});

it("retires an unsent mark only when the user turns Missions off, and starts nothing for a sent one", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const unsent = {
    environmentId: EnvironmentId.make("env-off"),
    threadId: ThreadId.make("unsent"),
  };
  const sent = { environmentId: EnvironmentId.make("env-off"), threadId: ThreadId.make("sent") };
  sentThreads.add(sent.threadId);
  createMission.mockClear();
  missions.turnedOff = true;
  markMissionDraft(unsent, { kind: "new" }, () => "m5");
  markMissionDraft(sent, { kind: "new" }, () => "m6");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MissionDraftCoordinator />
      </RegistryContext.Provider>,
    ),
  );
  expect(missionDraftOf(unsent)).toBeUndefined();
  expect(missionDraftOf(sent)?.step).toBe("waiting");
  expect(createMission).not.toHaveBeenCalled();
  missions.turnedOff = false;
  sentThreads.delete(sent.threadId);
});
