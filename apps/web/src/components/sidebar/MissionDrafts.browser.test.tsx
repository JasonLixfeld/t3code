import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import { markMissionDraft, MissionDraftCoordinator, useMissionDraftBanner } from "./MissionDrafts";

const LOCAL = EnvironmentId.make("local");
const thread = { environmentId: LOCAL, threadId: ThreadId.make("draft-thread") };
const commands = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const commandFor = (label: string) => {
  const existing = commands.get(label);
  if (existing !== undefined) return existing;
  const command = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.set(label, command);
  return command;
};

vi.mock("../../state/entities", { spy: true });
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: never, label: string) => commandFor(label)) as never,
}));

function Banner(props: { readonly draftId: DraftId }) {
  const items = useMissionDraftBanner(props.draftId);
  return items.map((item) => (
    <p key={item.id}>
      <span>{item.title}</span>
      <button type="button" onClick={item.onDismiss}>
        {item.dismissLabel}
      </button>
    </p>
  ));
}

/** The draft's thread as the stream shows it: not there, there but empty, or sent. */
async function renderDraft(draftId: DraftId) {
  commands.clear();
  // The stream's shells are live, as the real hook's are.
  let shell: ReturnType<typeof makeThreadFixture> | null = null;
  const listeners = new Set<() => void>();
  vi.mocked(useThreadShell).mockImplementation(() =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => shell,
    ),
  );
  const ui = () => (
    <>
      <MissionDraftCoordinator />
      <Banner draftId={draftId} />
    </>
  );
  const screen = await render(ui());
  return Object.assign(screen, {
    stream: (next: "empty" | "sent") => {
      shell = makeThreadFixture({
        environmentId: LOCAL,
        id: thread.threadId,
        title: "Plan the launch",
        ...(next === "sent"
          ? { latestUserMessageAt: "2026-01-01T00:00:00.000Z", visibleItemCount: 1 }
          : {}),
      });
      return act(() => {
        for (const listener of listeners) listener();
      });
    },
  });
}

it("starts a mission only once the draft's first message lands, led by that thread", async () => {
  const draftId = DraftId.make("mission-draft");
  await using screen = await renderDraft(draftId);
  await act(() => markMissionDraft(draftId, { intent: { kind: "new" }, thread }));
  await expect
    .element(screen.getByText("Sending starts a mission led by this thread"))
    .toBeInTheDocument();
  await screen.stream("empty");
  expect(commandFor("mission create")).not.toHaveBeenCalled();
  await screen.stream("sent");
  await vi.waitFor(() =>
    expect(commandFor("mission create")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: expect.stringMatching(/^[0-9a-f]{12}$/), leadThreadId: thread.threadId },
    }),
  );
  expect(screen.container.textContent).not.toContain("Sending starts a mission");
  await screen.stream("sent");
  expect(commandFor("mission create")).toHaveBeenCalledTimes(1);
});

it("makes nothing for a draft that is abandoned or sent as a plain thread", async () => {
  const draftId = DraftId.make("plain-draft");
  await using screen = await renderDraft(draftId);
  await act(() => markMissionDraft(draftId, { intent: { kind: "new" }, thread }));
  await userEvent.click(screen.getByRole("button", { name: "Send as a plain thread" }));
  await screen.stream("sent");
  expect(commandFor("mission create")).not.toHaveBeenCalled();
});

it("makes a new-lead draft the mission's lead once it is sent", async () => {
  const draftId = DraftId.make("lead-draft");
  await using screen = await renderDraft(draftId);
  const intent = {
    kind: "lead",
    host: LOCAL,
    missionId: "ba9876543210",
    name: "Old work",
  } as const;
  await act(() => markMissionDraft(draftId, { intent, thread }));
  await expect
    .element(screen.getByText('Sending makes this thread the lead of "Old work"'))
    .toBeInTheDocument();
  expect(commandFor("mission set lead")).not.toHaveBeenCalled();
  await screen.stream("sent");
  await vi.waitFor(() =>
    expect(commandFor("mission set lead")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "ba9876543210", lead: thread },
    }),
  );
});
