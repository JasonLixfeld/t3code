import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MissionError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { type ReactNode, useSyncExternalStore } from "react";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import { toastManager } from "../ui/toast";
import { useDraftMissionChoice } from "../chat/DraftMissionSelect";
import { markMissionDraft, missionDraftOf } from "./missionDraftStore";
import { MissionDraftCoordinator, useMissionDraftBanner } from "./MissionDrafts";
import { useMissionHosts } from "./MissionsSection";

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
vi.mock("./MissionsSection", { spy: true });
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: never, label: string) => commandFor(label)) as never,
}));

function MissionWord(props: { readonly draftId: DraftId }) {
  return useDraftMissionChoice(props.draftId, LOCAL)?.standalone ?? null;
}

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
async function renderDraft(draftId: DraftId, extra?: ReactNode) {
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
      {extra}
    </>
  );
  const screen = await render(ui());
  return Object.assign(screen, {
    /** The app remounts the watcher, as a route change can. */
    remount: async () => {
      await screen.rerender(<Banner draftId={draftId} />);
      await screen.rerender(ui());
    },
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
    .element(screen.getByText("Sending starts a new mission led by this thread"))
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
  await vi.waitFor(() =>
    expect(screen.container.textContent).not.toContain("Sending starts a new mission"),
  );
  await screen.stream("sent");
  expect(commandFor("mission create")).toHaveBeenCalledTimes(1);
});

it("starts a mission led by a draft once sent, when its Mission choice picked a new one", async () => {
  const draftId = DraftId.make("mission-choice-draft");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(LOCAL, ProjectId.make("project")), draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  await using screen = await renderDraft(draftId, <MissionWord draftId={draftId} />);
  await userEvent.click(page.getByRole("button", { name: "Add to a mission" }));
  await page.getByRole("menuitemradio", { name: "New mission (this thread leads)" }).click();
  await screen.stream("sent");
  await vi.waitFor(() =>
    expect(commandFor("mission create")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: expect.stringMatching(/^[0-9a-f]{12}$/), leadThreadId: threadId },
    }),
  );
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
    expectedLead: ThreadId.make("deleted-lead"),
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
      input: {
        missionId: "ba9876543210",
        lead: thread,
        expectedLead: ThreadId.make("deleted-lead"),
      },
    }),
  );
});

const busy = { _tag: "Failure", cause: Cause.fail(new Error("Server busy")) } as const;
const beaten = {
  _tag: "Failure",
  cause: Cause.fail(
    new MissionError({ message: "This mission already has a new lead.", reason: "lead-changed" }),
  ),
} as const;
const leadIntent = {
  kind: "lead",
  host: LOCAL,
  missionId: "ba9876543210",
  name: "Old work",
  expectedLead: ThreadId.make("deleted-lead"),
} as const;
const watchToasts = () => {
  const toasts = vi.spyOn(toastManager, "add");
  onTestFinished(() => toasts.mockRestore());
  return toasts;
};
const retryOf = (toast: unknown) =>
  (toast as { actionProps?: { onClick: () => void } }).actionProps;

it("keeps the mission until the server has it, and only the user's retry tries again", async () => {
  const draftId = DraftId.make("retry-draft");
  await using screen = await renderDraft(draftId);
  const toasts = watchToasts();
  const create = commandFor("mission create");
  create.mockResolvedValueOnce(busy);
  await act(() => markMissionDraft(draftId, { intent: { kind: "new" }, thread }));
  await screen.stream("sent");
  await vi.waitFor(() => expect(toasts).toHaveBeenCalledOnce());
  expect(screen.container.textContent).toContain("Sending starts a new mission");
  // A remount keeps the failure and sends nothing by itself.
  await screen.remount();
  await screen.stream("sent");
  expect(create).toHaveBeenCalledTimes(1);
  await act(() => retryOf(toasts.mock.calls[0]![0])!.onClick());
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  const [first, second] = create.mock.calls.map(
    ([call]) => (call as { input: { missionId: string } }).input.missionId,
  );
  expect(second).toBe(first);
  await vi.waitFor(() =>
    expect(screen.container.textContent).not.toContain("Sending starts a new mission"),
  );
});

it("leaves a new-lead draft plain when another window gave the mission a lead first", async () => {
  const draftId = DraftId.make("beaten-draft");
  await using screen = await renderDraft(draftId);
  const toasts = watchToasts();
  commandFor("mission set lead").mockResolvedValueOnce(beaten);
  await act(() => markMissionDraft(draftId, { intent: leadIntent, thread }));
  await screen.stream("sent");
  await vi.waitFor(() =>
    expect(toasts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "This mission already has a new lead" }),
    ),
  );
  expect(retryOf(toasts.mock.calls[0]![0])).toBeUndefined();
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Sending makes"));
  await screen.remount();
  expect(commandFor("mission set lead")).toHaveBeenCalledTimes(1);
});

it("stops offering a retry once the lead changed while the first try failed", async () => {
  const draftId = DraftId.make("stale-retry-draft");
  await using screen = await renderDraft(draftId);
  const toasts = watchToasts();
  const setLead = commandFor("mission set lead");
  setLead.mockResolvedValueOnce(busy).mockResolvedValueOnce(beaten);
  await act(() => markMissionDraft(draftId, { intent: leadIntent, thread }));
  await screen.stream("sent");
  await vi.waitFor(() => expect(toasts).toHaveBeenCalledOnce());
  await act(() => retryOf(toasts.mock.calls[0]![0])!.onClick());
  await vi.waitFor(() => expect(toasts).toHaveBeenCalledTimes(2));
  expect(setLead.mock.calls.map(([call]) => (call as { input: unknown }).input)).toEqual([
    { missionId: "ba9876543210", lead: thread, expectedLead: leadIntent.expectedLead },
    { missionId: "ba9876543210", lead: thread, expectedLead: leadIntent.expectedLead },
  ]);
  expect(toasts.mock.calls[1]![0]).toMatchObject({ title: "This mission already has a new lead" });
  expect(retryOf(toasts.mock.calls[1]![0])).toBeUndefined();
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Sending makes"));
});

it("joins a draft marked for a mission as a member once its first message lands", async () => {
  const draftId = DraftId.make("member-draft");
  await using screen = await renderDraft(draftId);
  const intent = {
    kind: "member",
    host: LOCAL,
    missionId: "ba9876543210",
    name: "Old work",
  } as const;
  await act(() => markMissionDraft(draftId, { intent, thread }));
  await expect
    .element(screen.getByText('Sending adds this thread to "Old work"'))
    .toBeInTheDocument();
  await screen.stream("empty");
  expect(commandFor("mission add member")).not.toHaveBeenCalled();
  await screen.stream("sent");
  await vi.waitFor(() =>
    expect(commandFor("mission add member")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "ba9876543210", member: thread, noBrief: true },
    }),
  );
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Sending adds"));
});

it("holds a member's join while its mission's machine no longer lists the mission", async () => {
  const draftId = DraftId.make("held-draft");
  vi.mocked(useMissionHosts).mockReturnValue([
    { environmentId: LOCAL, snapshot: { missions: [], links: [], claims: [] } },
  ]);
  onTestFinished(() => vi.mocked(useMissionHosts).mockRestore());
  await using screen = await renderDraft(draftId);
  const intent = {
    kind: "member",
    host: LOCAL,
    missionId: "ba9876543210",
    name: "Old work",
  } as const;
  await act(() => markMissionDraft(draftId, { intent, thread }));
  await screen.stream("sent");
  await vi.waitFor(() => expect(missionDraftOf(draftId)?.step).toBe("held"));
  expect(commandFor("mission add member")).not.toHaveBeenCalled();
  // The notice no longer says the thread is added.
  await expect
    .element(screen.getByText("This thread will not join a mission unless you pick one."))
    .toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("Sending adds");
});
