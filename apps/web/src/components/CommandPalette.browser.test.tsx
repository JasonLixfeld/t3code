import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { dispatchCommandPalette, useCommandPaletteStore } from "../commandPaletteStore";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { type EnvironmentPresentation, useEnvironments } from "../state/environments";
import { CommandPalette } from "./CommandPalette";
import { missionAddGroupValue } from "./CommandPaletteThreadActions";
import { markMissionDraft } from "./sidebar/missionDraftStore";
import { useMissionHosts, useMissionMenu } from "./sidebar/MissionsSection";
import { buildMissionMenuItems, type MissionHost } from "./sidebar/missions.logic";
import type { Mission } from "@t3tools/contracts";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useScratchProject } from "../hooks/useScratchProject";
import { DraftId } from "../composerDraftStore";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  activeThread: undefined as Thread | undefined,
  delegatedUnderParent: new Set<string>() as ReadonlySet<string>,
  handleNewThread: vi.fn(async () => undefined),
}));
vi.mock("../state/server", async (original) => {
  const actual = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const { THREAD_JUMP_KEYBINDING_COMMANDS } = await import("@t3tools/contracts");
  // The default jump bindings are desktop-only; these hold in the browser too.
  const jumpBindings = compileResolvedKeybindingsConfig(
    THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
      key: `mod+${index + 1}`,
      command,
    })),
  );
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(jumpBindings) };
});
vi.mock("../hooks/useHandleNewThread", async (original) => {
  const actual = await original<typeof import("../hooks/useHandleNewThread")>();
  return {
    ...actual,
    useHandleNewThread: () => ({
      ...actual.useHandleNewThread(),
      activeThread: entities.activeThread,
      handleNewThread: entities.handleNewThread,
    }),
  };
});
vi.mock("./sidebar/missionDraftStore", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("./sidebar/MissionsSection", { spy: true });
vi.mock("../hooks/useScratchProject", { spy: true });
vi.mock("../state/entities", async (original) => {
  const actual = await original<typeof import("../state/entities")>();
  const readThreadShell: typeof actual.readThreadShell = (ref) =>
    entities.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null;
  return {
    ...actual,
    useProjects: () => entities.projects,
    useVisibleThreadShells: () => entities.threads,
    useDelegatedUnderParent: () => entities.delegatedUnderParent,
    readThreadShell,
  };
});

function setup(state: Partial<typeof entities> = {}) {
  // Earlier browser test files share this origin's localStorage; a remembered project
  // that is not listed here hides the default "New thread in <project>" row.
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  entities.activeThread = state.activeThread;
  entities.delegatedUnderParent = state.delegatedUnderParent ?? new Set();
  entities.handleNewThread.mockClear();
}

function makeProject(title: string): Project {
  return {
    id: ProjectId.make(title),
    environmentId: EnvironmentId.make("local"),
    title,
    workspaceRoot: `/work/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("t3-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette({ query: "Drag this thread" });
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([
      { environmentId, threadId, title: "Drag this thread" },
    ]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("highlights the first project when New thread in... opens from the root list", async () => {
    const environmentId = EnvironmentId.make("local");
    const project = (id: string, title: string): Project => ({
      id: ProjectId.make(id),
      environmentId,
      title,
      workspaceRoot: `/work/${id}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    });
    setup({
      projects: [project("acme", "Acme"), project("beta", "Beta"), project("gamma", "Gamma")],
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
    await expect.element(page.getByRole("option").first()).toHaveAttribute("data-highlighted");
    await expect.element(page.getByRole("option").nth(1)).not.toHaveAttribute("data-highlighted");
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread, not a newer subagent, delegated task, or parked thread", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    const delegatedId = ThreadId.make("delegated");
    setup({
      delegatedUnderParent: new Set([threadKey({ environmentId, threadId: delegatedId })]),
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
        makeThreadFixture({
          id: delegatedId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-04T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("settled"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-05T00:00:00.000Z",
          settledOverride: "settled",
        }),
        makeThreadFixture({
          id: ThreadId.make("snoozed"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-06T00:00:00.000Z",
          snoozedUntil: "2999-01-01T00:00:00.000Z",
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "Acme" });
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });

  it("starts a thread in an open copy when the current project's copy is archived", async () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/example/acme",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/acme.git",
      },
    };
    const archived = {
      ...makeProject("acme"),
      repositoryIdentity,
      archivedAt: "2026-03-02T00:00:00.000Z",
    };
    const open = {
      ...makeProject("acme"),
      environmentId: EnvironmentId.make("remote"),
      repositoryIdentity,
    };
    setup({
      projects: [archived, open],
      activeThread: makeThreadFixture({
        environmentId: archived.environmentId,
        projectId: archived.id,
      }),
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await page.getByRole("option", { name: /acme/i }).click();

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledWith({
        environmentId: open.environmentId,
        projectId: open.id,
      }),
    );
  });

  it("offers a new member only machines its mission's machine can add from", async () => {
    const local = makeProject("web");
    const linked = { ...makeProject("api"), environmentId: EnvironmentId.make("linked") };
    const fenced = { ...makeProject("docs"), environmentId: EnvironmentId.make("fenced") };
    setup({ projects: [local, linked, fenced] });
    vi.mocked(useMissionHosts).mockReturnValue([
      {
        environmentId: local.environmentId,
        snapshot: {
          missions: [],
          claims: [],
          links: [
            { environmentId: linked.environmentId, label: "Linked", fullAccess: true },
            { environmentId: fenced.environmentId, label: "Fenced", fullAccess: false },
          ],
        },
      },
    ]);
    onTestFinished(() => vi.mocked(useMissionHosts).mockRestore());
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const member = {
      kind: "member",
      host: local.environmentId,
      missionId: "0123456789ab",
      name: "Ship v2",
    } as const;
    openCommandPalette({ open: "new-thread-in", mission: member });
    await expect.element(page.getByRole("option", { name: /web/ })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /api/ })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /docs/ })).not.toBeInTheDocument();
  });

  it("titles the New mission picker and offers No project, on the lead's machine for a new lead", async () => {
    const local = makeProject("web");
    setup({ projects: [local] });
    vi.mocked(markMissionDraft).mockClear();
    // Only the local machine has a home for threads without a project.
    const scratch = { ...makeProject("scratch"), workspaceRoot: "/scratch/home" };
    const openScratchProject = vi.fn().mockResolvedValue(scratch);
    vi.mocked(useScratchProject).mockReturnValue({
      scratchEnvironmentId: () => local.environmentId,
      scratchWorkspaceRootFor: (environmentId: EnvironmentId | null) =>
        environmentId === local.environmentId ? "/scratch" : null,
      startScratchThread: vi.fn(),
      openScratchProject,
    } as never);
    onTestFinished(() => vi.mocked(useScratchProject).mockRestore());
    const created = { draftId: DraftId.make("mission-draft"), threadId: ThreadId.make("t") };
    entities.handleNewThread.mockResolvedValueOnce(created as never);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in", mission: { kind: "new" } });
    await expect.element(page.getByText("New mission", { exact: true })).toBeVisible();
    await page.getByRole("option", { name: /No project/ }).click();
    await vi.waitFor(() =>
      expect(markMissionDraft).toHaveBeenCalledExactlyOnceWith(created.draftId, {
        intent: { kind: "new" },
        thread: { environmentId: local.environmentId, threadId: created.threadId },
      }),
    );
    expect(openScratchProject).toHaveBeenCalledWith(local.environmentId);

    // A lead on a machine with no such home is not offered one.
    const lead = {
      kind: "lead",
      host: EnvironmentId.make("remote"),
      missionId: "ba9876543210",
      name: "Old work",
      expectedLead: ThreadId.make("deleted-lead"),
    } as const;
    openCommandPalette({ open: "new-thread-in", mission: lead });
    await expect.element(page.getByText("New lead", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /No project/ })).not.toBeInTheDocument();
  });

  it("marks the draft a mission's project pick makes, offering only the lead's machine", async () => {
    const local = makeProject("web");
    const remote = { ...makeProject("api"), environmentId: EnvironmentId.make("remote") };
    setup({ projects: [local, remote] });
    vi.mocked(markMissionDraft).mockClear();
    const created = { draftId: DraftId.make("lead-draft"), threadId: ThreadId.make("lead-thread") };
    entities.handleNewThread.mockResolvedValueOnce(created as never);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const intent = {
      kind: "lead",
      host: local.environmentId,
      missionId: "ba9876543210",
      name: "Old work",
      expectedLead: ThreadId.make("deleted-lead"),
    } as const;

    openCommandPalette({ open: "new-thread-in", mission: intent });
    await expect.element(page.getByRole("option", { name: /web/ })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /api/ })).not.toBeInTheDocument();
    await page.getByRole("option", { name: /web/ }).click();

    await vi.waitFor(() =>
      expect(markMissionDraft).toHaveBeenCalledExactlyOnceWith(created.draftId, {
        intent,
        thread: { environmentId: local.environmentId, threadId: created.threadId },
      }),
    );
  });

  it("offers the copy on the lead's machine of a repository on two machines", async () => {
    const repository = {
      canonicalKey: "github.com/acme/web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web",
      },
      provider: "github",
      owner: "acme",
      name: "web",
      displayName: "acme/web",
    } as unknown as Project["repositoryIdentity"];
    const local = { ...makeProject("web"), repositoryIdentity: repository };
    const remote = {
      ...local,
      id: ProjectId.make("web-remote"),
      environmentId: EnvironmentId.make("remote"),
    };
    setup({ projects: [local, remote] });
    vi.mocked(markMissionDraft).mockClear();
    const created = { draftId: DraftId.make("lead-draft"), threadId: ThreadId.make("lead-thread") };
    entities.handleNewThread.mockResolvedValueOnce(created as never);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const intent = {
      kind: "lead",
      host: remote.environmentId,
      missionId: "ba9876543210",
      name: "Old work",
      expectedLead: ThreadId.make("deleted-lead"),
    } as const;

    openCommandPalette({ open: "new-thread-in", mission: intent });
    await page.getByRole("option", { name: /web/ }).click();

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledExactlyOnceWith({
        environmentId: remote.environmentId,
        projectId: remote.id,
      }),
    );
    expect(markMissionDraft).toHaveBeenCalledExactlyOnceWith(created.draftId, {
      intent,
      thread: { environmentId: remote.environmentId, threadId: created.threadId },
    });
  });

  it("drops a mission's intent when the picker is left, so New thread in... stays plain", async () => {
    setup({ projects: [makeProject("web")] });
    vi.mocked(markMissionDraft).mockClear();
    entities.handleNewThread.mockResolvedValueOnce({
      draftId: DraftId.make("plain-draft"),
      threadId: ThreadId.make("plain-thread"),
    } as never);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const intent = {
      kind: "lead",
      host: EnvironmentId.make("local"),
      missionId: "ba9876543210",
      name: "Old work",
      expectedLead: ThreadId.make("deleted-lead"),
    } as const;

    openCommandPalette({ open: "new-thread-in", mission: intent });
    await expect.element(page.getByRole("option", { name: /web/ })).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
    await userEvent.keyboard("{Backspace}");
    await page.getByRole("option", { name: /^New thread in\.\.\./ }).click();
    await page.getByRole("option", { name: /web/ }).click();

    await vi.waitFor(() => expect(entities.handleNewThread).toHaveBeenCalledOnce());
    expect(markMissionDraft).not.toHaveBeenCalled();
  });

  it("numbers filtered New thread in... rows from 1 and jumps to them", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    setup({ projects: [makeProject("server"), makeProject("lima")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await userEvent.fill(page.getByPlaceholder("Search..."), "li");
    await expect.element(page.getByRole("option", { name: /server/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /lima/ })).toMatchTextContent("Ctrl+1");
    await userEvent.keyboard("{Control>}1{/Control}");

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("local"),
        projectId: ProjectId.make("lima"),
      }),
    );
  });

  it("leaves a submenu only on a fresh, unmodified Backspace", async () => {
    setup({ projects: [makeProject("Acme"), makeProject("Beta")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const rootInput = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(rootInput).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    const submenuInput = page.getByPlaceholder("Search...");
    await expect.element(submenuInput).toHaveFocus();

    for (const init of [
      { repeat: true },
      { ctrlKey: true },
      { isComposing: true },
    ] satisfies ReadonlyArray<KeyboardEventInit>) {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(() => submenuInput.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(submenuInput).toBeVisible();
    }

    await userEvent.keyboard("{Backspace}");
    await expect.element(rootInput).toHaveFocus();
  });

  it("ignores repeated Escape keydowns after stepping back from file search", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const palette = page.getByTestId("command-palette");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await act(() => {
      dispatchCommandPalette({
        _tag: "OpenChildSearch",
        mode: "files",
        context: { query: "", linkedThreadSearch: null },
      });
    });
    await expect.element(palette).toHaveAttribute("data-palette-mode", "files");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();

    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useCommandPaletteStore.getState().open).toBe(true);
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).not.toBeInTheDocument();
  });
});

describe("CommandPalette mission thread actions", () => {
  const LOCAL = EnvironmentId.make("local");
  const hostWith = (
    missionNames: ReadonlyArray<string>,
    missionIds = missionNames.map((_, index) => `ba987654321${index}`),
    members: Mission["members"] = [],
  ): MissionHost => ({
    environmentId: LOCAL,
    snapshot: {
      missions: missionNames.map((name, index) => ({
        missionId: missionIds[index]!,
        name,
        createdAt: "2026-11-23T00:00:00.000Z",
        members,
      })),
      links: [],
      claims: [],
    },
  });
  const missionRun = vi.fn(async () => []);
  const listed = { hosts: [] as ReadonlyArray<MissionHost>, listeners: new Set<() => void>() };
  const subscribe = (listener: () => void) => {
    listed.listeners.add(listener);
    return () => listed.listeners.delete(listener);
  };
  const itemsOn =
    (hosts: ReadonlyArray<MissionHost>) => (threads: Parameters<typeof buildMissionMenuItems>[0]) =>
      buildMissionMenuItems(
        threads,
        hosts,
        () => "This machine",
        () => true,
      );
  const listMissions = (hosts: ReadonlyArray<MissionHost>) => {
    listed.hosts = hosts;
    missionRun.mockClear();
    vi.mocked(useMissionMenu).mockImplementation(() => ({
      items: itemsOn(useSyncExternalStore(subscribe, () => listed.hosts)),
      rowItems: () => [],
      run: missionRun,
    }));
    onTestFinished(() => vi.mocked(useMissionMenu).mockRestore());
    return itemsOn(hosts);
  };
  /** The machine's list changes, as a mission made or deleted elsewhere changes it. */
  const relistMissions = (hosts: ReadonlyArray<MissionHost>) =>
    act(() => {
      listed.hosts = hosts;
      for (const listener of listed.listeners) listener();
    });
  const openThread = (messages: boolean) => {
    const thread = makeThreadFixture({
      environmentId: LOCAL,
      id: ThreadId.make(messages ? "talked" : "quiet"),
      title: "Plan the launch",
      ...(messages ? { latestUserMessageAt: "2026-11-24T00:00:00.000Z", visibleItemCount: 1 } : {}),
    });
    setup({ threads: [thread], activeThread: thread });
    return thread;
  };

  it("lists a thread's mission actions, and Add to mission adds it to the picked mission", async () => {
    listMissions([hostWith(["Ship v2", "Billing cleanup"])]);
    const thread = openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await expect
      .element(page.getByRole("option", { name: /Start mission from this thread/ }))
      .toBeVisible();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    await expect.element(page.getByRole("option", { name: /Billing cleanup/ })).toBeVisible();
    await page.getByRole("option", { name: /Ship v2/ }).click();
    await vi.waitFor(() =>
      expect(missionRun).toHaveBeenCalledWith("mission-add:local:ba9876543210", [
        { environmentId: LOCAL, threadId: thread.id },
      ]),
    );
  });

  it("disables mission actions with the context menu's reasons", async () => {
    const items = listMissions([hostWith([])]);
    const thread = openThread(false);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    const expected = items([thread]);
    expect(expected.map((item) => item.detail)).toEqual(["No messages yet", "No missions yet"]);
    for (const item of expected) {
      const title = page.getByText(item.label, { exact: true });
      await expect.element(title).toBeVisible();
      expect(title.element().closest("[role=option]")).toBeNull();
      expect(title.element().parentElement?.parentElement?.textContent).toBe(
        `${item.label}${item.detail}`,
      );
    }
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)(
    "with Missions %s, the palette's thread actions show mission actions or none",
    async (_, on) => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarMissionsEnabled: on });
      onTestFinished(() => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS));
      openThread(true);
      await using screen = await render(<CommandPalette>{null}</CommandPalette>);
      openCommandPalette();
      await expect.element(page.getByRole("option", { name: "Copy", exact: true })).toBeVisible();
      const listed = () => screen.container.ownerDocument.body.textContent ?? "";
      expect(listed().includes("Add to mission")).toBe(on);
    },
  );

  it("keeps Add to mission's list live while it is open", async () => {
    listMissions([hostWith(["Ship v2", "Billing cleanup"])]);
    const thread = openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    await expect.element(page.getByRole("option", { name: /Billing cleanup/ })).toBeVisible();
    // Billing cleanup is deleted and Launch week is made while the view is open.
    await relistMissions([hostWith(["Ship v2", "Launch week"], ["ba9876543210", "ba9876543212"])]);
    await expect.element(page.getByRole("option", { name: /Launch week/ })).toBeVisible();
    expect(page.getByText("Billing cleanup").elements()).toHaveLength(0);
    await page.getByRole("option", { name: /Launch week/ }).click();
    await vi.waitFor(() =>
      expect(missionRun).toHaveBeenCalledWith("mission-add:local:ba9876543212", [
        { environmentId: LOCAL, threadId: thread.id },
      ]),
    );
  });

  it("shows open Add to mission disabled once no mission is left, and leaves it once it is gone", async () => {
    listMissions([hostWith(["Ship v2"])]);
    const thread = openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    await expect.element(page.getByRole("option", { name: /Ship v2/ })).toBeVisible();
    await relistMissions([hostWith([])]);
    await expect.element(page.getByText("No missions yet")).toBeVisible();
    await expect.element(page.getByText("Backspace", { exact: true })).toBeVisible();
    expect(page.getByRole("option", { name: /Ship v2/ }).elements()).toHaveLength(0);
    // The thread now leads a mission, so it has no Add to mission at all.
    const lead = { ref: { environmentId: LOCAL, threadId: thread.id }, role: "lead" as const };
    await relistMissions([hostWith(["Ship v2"], undefined, [{ ...lead, state: "active" }])]);
    await expect.element(page.getByRole("option", { name: "Copy", exact: true })).toBeVisible();
    await expect.element(page.getByText("Backspace", { exact: true })).not.toBeInTheDocument();
  });

  it("offers a mission's lead only its thread actions, not the mission's own commands", async () => {
    const thread = openThread(true);
    listMissions([
      hostWith(["Ship v2"], undefined, [
        { ref: { environmentId: LOCAL, threadId: thread.id }, role: "lead", state: "active" },
      ]),
    ]);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await expect.element(page.getByRole("option", { name: "Copy", exact: true })).toBeVisible();
    const shown = document.body.textContent ?? "";
    for (const command of ["Delete mission", "New thread in this mission", "Edit mission prompt"]) {
      expect(shown).not.toContain(command);
    }
    expect(page.getByText("Mission", { exact: true }).elements()).toHaveLength(0);
  });

  it("keeps a search in Add to mission to that view, and its reason row while text is typed", async () => {
    listMissions([hostWith(["Ship v2"])]);
    openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    const search = page.getByRole("combobox");
    await userEvent.fill(search, "Copy");
    await expect
      .element(page.getByText("No matching commands, projects, or threads."))
      .toBeVisible();
    expect(page.getByRole("option", { name: "Copy", exact: true }).elements()).toHaveLength(0);
    await userEvent.fill(search, "Ship v2");
    await expect.element(page.getByRole("option", { name: /Ship v2/ })).toBeVisible();
    await relistMissions([hostWith([])]);
    await expect.element(page.getByText("No missions yet")).toBeVisible();
    await expect.element(page.getByText("Backspace", { exact: true })).toBeVisible();
  });

  it("closes Add to mission when another thread opens, even one whose plain key reads the same", async () => {
    const first = {
      environmentId: EnvironmentId.make("lab:team"),
      threadId: ThreadId.make("task"),
    };
    const second = {
      environmentId: EnvironmentId.make("lab"),
      threadId: ThreadId.make("team:task"),
    };
    expect(missionAddGroupValue(first)).not.toBe(missionAddGroupValue(second));
    const [threadA, threadB] = [first, second].map((ref) =>
      makeThreadFixture({
        environmentId: ref.environmentId,
        id: ref.threadId,
        title: "Plan the launch",
        latestUserMessageAt: "2026-11-24T00:00:00.000Z",
        visibleItemCount: 1,
      }),
    );
    const hosts = [hostWith(["Ship v2"])];
    listMissions(hosts);
    setup({ threads: [threadA!, threadB!], activeThread: threadA });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    await expect.element(page.getByText("Backspace", { exact: true })).toBeVisible();
    entities.activeThread = threadB;
    await relistMissions([...hosts]);
    await expect.element(page.getByText("Backspace", { exact: true })).not.toBeInTheDocument();
  });

  /** A connected machine, where a path-shaped query would otherwise browse its folders. */
  const connectMachine = async () => {
    const actual =
      await vi.importActual<typeof import("../state/environments")>("../state/environments");
    const machine: EnvironmentPresentation = {
      environmentId: LOCAL,
      label: "This machine",
      displayUrl: null,
      relayManaged: false,
      entry: {
        target: new PrimaryConnectionTarget({
          environmentId: LOCAL,
          label: "This machine",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      },
      connection: { phase: "connected", error: null, traceId: null },
      refusedRouteIds: [],
      serverConfig: null,
    };
    vi.mocked(useEnvironments).mockImplementation(() => ({
      ...actual.useEnvironments(),
      environments: [machine],
    }));
    onTestFinished(() => vi.mocked(useEnvironments).mockRestore());
  };
  const searchAddToMission = async (query: string) => {
    openCommandPalette();
    await page.getByRole("option", { name: /Add to mission/ }).click();
    await userEvent.fill(page.getByRole("combobox"), query);
  };

  it("finds a mission named like a path in Add to mission, and Enter adds it", async () => {
    await connectMachine();
    listMissions([hostWith(["~/work/cleanup", "Ship v2"])]);
    const thread = openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await searchAddToMission("~/work/");
    await expect.element(page.getByRole("option", { name: /~\/work\/cleanup/ })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(missionRun).toHaveBeenCalledWith("mission-add:local:ba9876543210", [
        { environmentId: LOCAL, threadId: thread.id },
      ]),
    );
  });

  it("keeps Add to mission's reason row under a path-shaped query", async () => {
    await connectMachine();
    listMissions([hostWith(["~/work/cleanup"])]);
    openThread(true);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await searchAddToMission("~/work/");
    await expect.element(page.getByRole("option", { name: /~\/work\/cleanup/ })).toBeVisible();
    await relistMissions([hostWith([])]);
    await expect.element(page.getByText("No missions yet")).toBeVisible();
    await expect.element(page.getByText("Backspace", { exact: true })).toBeVisible();
  });

  it("releases a member thread from its mission, and leaves it, from the palette", async () => {
    const thread = openThread(true);
    const ref = { environmentId: LOCAL, threadId: thread.id };
    const host = hostWith(["Ship v2"], undefined, [{ ref, role: "member", state: "active" }]);
    const claims = [{ threadId: thread.id, missionId: "ba9876543210", name: "Ship v2" }];
    listMissions([{ ...host, snapshot: { ...host.snapshot, claims } }]);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    for (const [label, id] of [
      ["Release from mission", "mission-release:local:ba9876543210"],
      ["Leave mission", "mission-leave"],
    ] as const) {
      openCommandPalette();
      await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
      await vi.waitFor(() => expect(missionRun).toHaveBeenCalledWith(id, [ref]));
    }
  });
});
