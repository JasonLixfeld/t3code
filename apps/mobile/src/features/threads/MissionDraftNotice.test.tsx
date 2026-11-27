import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
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
import { MissionDraftNotice } from "./MissionDraftNotice";

type NoticeProps = { message: string; dismissLabel?: string; onDismiss?: () => void };
const notice = vi.hoisted(() => ({ current: null as NoticeProps | null, turnedOff: false }));
const shown = (): NoticeProps | null => notice.current;

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../state/missions", () => ({ useMissionsTurnedOff: () => notice.turnedOff }));
vi.mock("../../components/ui/Notice", () => ({
  Notice: (props: NoticeProps) => {
    notice.current = props;
    return null;
  },
}));

it("offers a dismiss except while trying, ignores a tap on a mark that has changed, and hides while Missions are off", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const thread = { environmentId: EnvironmentId.make("env-desk"), threadId: ThreadId.make("t1") };
  markMissionDraft(thread, { kind: "new" }, () => "m1");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <MissionDraftNotice thread={thread} />
        </RegistryContext.Provider>,
      ),
    );
  render();
  expect(shown()?.onDismiss).toBeTypeOf("function");
  act(() =>
    markMissionDraft(
      thread,
      { kind: "member", host: thread.environmentId, missionId: "m0", name: "Docs" },
      () => "m0",
    ),
  );
  expect(shown()?.message).toContain("Docs");

  let attempt = 0;
  act(() => {
    attempt = startMissionDraftAttempt(thread);
  });
  expect(shown()?.onDismiss).toBeUndefined();

  act(() => settleMissionDraftAttempt(thread, attempt, "failed"));
  const staleTap = shown()?.onDismiss;
  expect(staleTap).toBeTypeOf("function");
  act(() => markMissionDraft(thread, { kind: "new" }, () => "m2"));
  act(() => staleTap?.());
  expect(missionDraftOf(thread)?.missionId).toBe("m2");

  act(() => shown()?.onDismiss?.());
  expect(missionDraftOf(thread)).toBeUndefined();

  markMissionDraft(thread, { kind: "new" }, () => "m3");
  notice.current = null;
  notice.turnedOff = true;
  render();
  expect(shown()).toBeNull();
  notice.turnedOff = false;
});
