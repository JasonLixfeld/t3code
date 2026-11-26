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
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/missions", () => {
  const noHosts: ReadonlyArray<never> = [];
  return { useMissionHosts: () => noHosts };
});
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => createMission }));
vi.mock("./useMissionActions", () => ({
  reportLeadOutcome: vi.fn(),
  reportMissionFailure: vi.fn(),
}));

it("keeps a waiting mark while its thread is not delivered, and clears it once the thread is removed", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const thread = { environmentId: EnvironmentId.make("env-desk"), threadId: ThreadId.make("t1") };
  markMissionDraft(thread, { kind: "new" }, () => "m1");
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
  expect(createMission).not.toHaveBeenCalled();

  act(() =>
    appAtomRegistry.set(
      environmentShell.stateValueAtom(thread.environmentId) as unknown as Atom.Writable<{
        removedAt: ReadonlyMap<string, number>;
      }>,
      { removedAt: new Map([[thread.threadId, 2]]) },
    ),
  );
  expect(missionDraftOf(thread)).toBeUndefined();
  expect(createMission).not.toHaveBeenCalled();
});

it("clears a failed mark once its thread is removed", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const thread = { environmentId: EnvironmentId.make("env-laptop"), threadId: ThreadId.make("t2") };
  markMissionDraft(thread, { kind: "new" }, () => "m2");
  settleMissionDraftAttempt(thread, startMissionDraftAttempt(thread), "failed");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MissionDraftCoordinator />
      </RegistryContext.Provider>,
    ),
  );
  expect(missionDraftOf(thread)?.step).toBe("failed");

  act(() =>
    appAtomRegistry.set(
      environmentShell.stateValueAtom(thread.environmentId) as unknown as Atom.Writable<{
        removedAt: ReadonlyMap<string, number>;
      }>,
      { removedAt: new Map([[thread.threadId, 3]]) },
    ),
  );
  expect(missionDraftOf(thread)).toBeUndefined();
});
