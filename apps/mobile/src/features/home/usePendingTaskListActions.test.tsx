import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { markMissionDraft, missionDraftOf } from "../../state/mission-drafts";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { usePendingTaskListActions } from "./usePendingTaskListActions";

type Button = { readonly style?: string; readonly onPress?: () => void };
const alerts = vi.hoisted(() => [] as Array<ReadonlyArray<Button>>);

vi.mock("../../components/ui/Dialog", () => ({
  alert: (_title: string, _message: string, buttons: ReadonlyArray<Button>) => alerts.push(buttons),
}));
vi.mock("../../state/thread-outbox-removal", () => ({
  removeThreadOutboxMessage: async () => true,
}));
vi.mock("../../state/use-composer-drafts", () => ({ clearComposerDraftContent: () => {} }));
vi.mock("../../state/use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    holdEditingQueuedMessage: () => {},
    releaseEditingQueuedMessage: () => {},
  };
});
vi.mock("./thread-dismissal", () => ({
  withThreadDismissal: (_key: string, run: () => Promise<unknown>) => run(),
}));

const environmentId = EnvironmentId.make("env-desk");
const threadId = ThreadId.make("queued");

it("drops the mission mark of a discarded draft and of a deleted queued task", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  let actions: ReturnType<typeof usePendingTaskListActions> | null = null;
  function Probe() {
    actions = usePendingTaskListActions(() => {});
    return null;
  }
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<Probe />));
  const confirm = async (task: PendingNewTask) => {
    actions?.confirmDeletePendingTask(task);
    await act(async () =>
      alerts
        .at(-1)
        ?.find((button) => button.style === "destructive")
        ?.onPress?.(),
    );
  };

  markMissionDraft({ draftId: "draft-1" }, { kind: "new" }, () => "m1");
  await confirm({ kind: "draft", key: "draft-1", draftKey: "draft-1", title: "Draft" } as never);
  expect(missionDraftOf({ draftId: "draft-1" })).toBeUndefined();

  markMissionDraft({ environmentId, threadId }, { kind: "new" }, () => "m2");
  await confirm({
    kind: "pending",
    key: "pending-1",
    title: "Queued",
    environmentId,
    message: { environmentId, threadId, messageId: MessageId.make("msg-1") },
  } as never);
  expect(missionDraftOf({ environmentId, threadId })).toBeUndefined();
});
