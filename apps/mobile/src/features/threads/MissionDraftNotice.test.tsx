import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { markMissionDraft, missionDraftOf } from "../../state/mission-drafts";
import { MissionDraftNotice } from "./MissionDraftNotice";

type NoticeProps = { message: string; dismissLabel: string; onDismiss: () => void };
const notice = vi.hoisted(() => ({ current: null as NoticeProps | null }));
const shown = (): NoticeProps | null => notice.current;

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Notice", () => ({
  Notice: (props: NoticeProps) => {
    notice.current = props;
    return null;
  },
}));

it("tells an empty thread that sending starts its mission, and sends it as a plain thread on dismiss", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const thread = { environmentId: EnvironmentId.make("env-desk"), threadId: ThreadId.make("t1") };
  markMissionDraft(thread, { kind: "new" }, () => "m1");
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MissionDraftNotice thread={thread} />
      </RegistryContext.Provider>,
    ),
  );
  expect(notice.current).toMatchObject({
    message: "Sending starts a new mission led by this thread",
    dismissLabel: "Send as a plain thread",
  });

  notice.current = null;
  act(() => {
    markMissionDraft(
      thread,
      { kind: "member", host: thread.environmentId, missionId: "m2", name: "Docs" },
      () => "m3",
    );
  });
  expect(shown()?.message).toBe('Sending adds this thread to "Docs"');

  act(() => shown()?.onDismiss());
  expect(missionDraftOf(thread)).toBeUndefined();
});
