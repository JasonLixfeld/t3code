import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  CheckpointRef,
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type ClientSettings,
  type OrchestrationGetTurnDiffResult,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  project: {
    workspaceRoot: "/project",
    repositoryIdentity: null as { rootPath: string } | null,
  },
  toolCallItem: null as unknown,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
  checkpoints: [] as unknown[],
  checkpointDiff: null as Partial<OrchestrationGetTurnDiffResult> | null,
  realFileTree: false,
}));

vi.mock("~/state/server", async () => ({
  serverEnvironment: { configValueAtom: () => state.config },
  primaryServerKeybindingsAtom: (await import("effect/reactivity")).Atom.make(
    (await import("@t3tools/shared/keybindings")).mergeWithDefaultKeybindings([]),
  ),
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: () => state.patch,
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
}));
// A client without preview:operate, which the chat route's browser find requires.
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  readEnvironmentScope: () => false,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
  readProjects: () => [],
  readThreadShell: () => null,
  useQuietThreadShell: () => state.thread,
  useProject: () => state.project,
  useThreadCheckpointSummaries: () => state.checkpoints,
  useQuietThreadVisibleTurnItems: () => [],
  useQuietThreadProjection: () => null,
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
  filesystemEnvironment: {},
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => state.threadRef }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: state.diffFilesCollapsed }),
  updateClientSettings: async () => {},
}));
vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: state.checkpointDiff, error: null, isPending: false }),
  useTurnItemDetail: () => ({
    data: state.toolCallItem ? { item: state.toolCallItem } : null,
    error: null,
    isPending: false,
  }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("./diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("./diffs/DiffFileTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diffs/DiffFileTree")>();
  return {
    DiffFileTree: (props: Parameters<typeof actual.DiffFileTree>[0]) =>
      state.realFileTree ? <actual.DiffFileTree {...props} /> : null,
  };
});
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));

import DiffPanel from "./DiffPanel";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { installChatRouteCommands } from "~/shortcuts/chatRouteCommands";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { RightPanelTabs } from "./RightPanelTabs";

const panelContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: true,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});
const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: "",
        diffHash: "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null) {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
    localStorage.removeItem("t3code.diffFileTreeOpen");
  };
  reset();
  state.diffFilesCollapsed = false;
  state.realFileTree = false;
  state.project = { workspaceRoot: "/project", repositoryIdentity: null };
  state.toolCallItem = null;
  state.checkpoints = [];
  state.checkpointDiff = null;
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.patch = patch;
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
          getShortcutContext={panelContext}
        />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

it("opens a repository-relative file from a nested project without a remote", async () => {
  using context = setup("origin/orphan");
  state.thread = { ...state.thread!, worktreePath: null };
  const path = "project/back\\slash.txt";
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 0 }],
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  state.status = Atom.make(
    AsyncResult.success({
      ...AsyncResult.getOrElse(context.registry.get(state.status), () => {
        throw new Error("Missing status");
      }),
      workingTree: { rootPath: "/", files: [], insertions: 0, deletions: 0 },
    }),
  );
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel
        composerDraftTarget={context.threadRef}
        workspaceMutationId={null}
        visible
        getShortcutContext={panelContext}
      />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByText(path, { exact: true }));
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
  ).toMatchObject({ activeSurfaceId: "file:back\\slash.txt" });
});

it.each([false, true])(
  "expands an unloaded file on the first click with default collapse %s",
  async (collapsed) => {
    using context = setup("origin/orphan");
    state.diffFilesCollapsed = collapsed;
    const path = `pending-${collapsed}.txt`;
    const metadata = preview();
    const source = {
      ...metadata.sources[0]!,
      files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
    };
    state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel
            composerDraftTarget={context.threadRef}
            workspaceMutationId={null}
            visible
            getShortcutContext={panelContext}
          />
        </div>
      </RegistryContext.Provider>,
    );
    const toggle = screen.getByRole("button", { name: `Expand ${path}`, exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await act(() =>
      context.registry.set(
        context.patch,
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
        }),
      ),
    );
    const loadedToggle = screen.getByRole("button", { name: `Collapse ${path}`, exact: true });
    await expect.element(loadedToggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("after", { exact: true })).toBeVisible();
    await userEvent.click(loadedToggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  },
);

it("says a turn diff cut off at the server's size limit is incomplete", async () => {
  using context = setup("origin/orphan");
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: "diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -0,0 +1 @@\n+visible\n\n[truncated]",
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"));
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
          getShortcutContext={panelContext}
        />
      </div>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("first.txt", { exact: true }).first()).toBeVisible();
  await expect
    .element(screen.getByText("This preview exceeds the size limit. Changes shown are incomplete."))
    .toBeVisible();
});

it("shows a turn's repositories in a folder that is not a Git repository", async () => {
  using context = setup("origin/orphan");
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const patch = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
  const repository = (name: string) => ({
    scopeId: CheckpointScopeId.make(`scope-${name}`),
    name,
    repositoryPath: `${cwd}/${name}`,
    cwd: `${cwd}/${name}`,
    relativePath: name,
    files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
    baselineMissing: false,
  });
  state.checkpoints = [
    {
      runId: RunId.make("run-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/root-1"),
      status: "missing",
      files: [],
      repositories: [repository("api"), repository("web")],
      assistantMessageId: null,
      completedAt: "2026-11-10T00:00:00.000Z",
    },
  ];
  state.checkpointDiff = {
    threadId: context.threadRef.threadId,
    fromTurnCount: 0,
    toTurnCount: 1,
    diff: "",
    repositories: ["api", "web"].map((name) => ({
      name,
      repositoryPath: `${cwd}/${name}`,
      relativePath: name,
      diff: patch("README.md"),
    })),
  };
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width: 390, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
          getShortcutContext={panelContext}
        />
      </div>
    </RegistryContext.Provider>,
  );
  const api = screen.getByRole("button", { name: "Collapse api/README.md", exact: true });
  const web = screen.getByRole("button", { name: "Collapse web/README.md", exact: true });
  await expect.element(api).toBeVisible();
  await expect.element(web).toBeVisible();
  // Both pickers keep their labels in a phone-width panel.
  await expect.element(screen.getByText("Latest turn", { exact: true })).toBeVisible();
  const picker = screen.getByRole("button", { name: "Repository: All repositories" });
  await expect.element(picker.getByText("All repositories")).toBeVisible();
  await userEvent.click(picker);
  await userEvent.click(page.getByRole("menuitemradio", { name: "web" }));
  await expect.element(web).toBeVisible();
  await expect.element(api).not.toBeInTheDocument();
});

// Paths as git's numstat reports them; the parsed patch keeps their edge whitespace.
it.each([
  { path: " leading.ts", name: " leading.ts" },
  { path: "src/trailing.ts ", name: "src/trailing.ts " },
])("reveals the turn file $path picked from the changed files", async ({ path, name }) => {
  using context = setup("origin/orphan");
  state.diffFilesCollapsed = true;
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\t\n@@ -0,0 +1 @@\n+revealed\n`,
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"), path);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
          getShortcutContext={panelContext}
        />
      </div>
    </RegistryContext.Provider>,
  );
  await expect
    .element(screen.getByRole("button", { name: `Collapse ${name}`, exact: true }))
    .toHaveAttribute("aria-expanded", "true");
});

it("opens a file from a tool call's diff by the path its agent recorded", async () => {
  using context = setup("origin/orphan");
  // A local thread in a project that is the repository's apps/web folder.
  state.thread = { ...state.thread!, worktreePath: null };
  state.project = { workspaceRoot: "/repo/apps/web", repositoryIdentity: { rootPath: "/repo" } };
  const status = AsyncResult.getOrThrow(context.registry.get(state.status));
  state.status = Atom.make(
    AsyncResult.success({ ...status, workingTree: { ...status.workingTree, rootPath: "/repo" } }),
  );
  // Claude's Edit can record a path relative to the workspace, unlike the repository's diffs.
  state.toolCallItem = {
    type: "file_change",
    fileName: "src/a.ts",
    diffStr: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-before\n+after\n",
  };
  useDiffPanelStore.getState().selectToolCall(context.threadRef, {
    threadId: context.threadRef.threadId,
    itemId: TurnItemId.make("edit"),
    revision: "1",
  });
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
          getShortcutContext={panelContext}
        />
      </div>
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByText("src/a.ts", { exact: true }));
  await vi.waitFor(() =>
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
    ).toMatchObject({ activeSurfaceId: "file:src/a.ts" }),
  );
});

const FIND_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const retry = 1;\n-old retry\n+new retry retry\n",
  "diff --git a/lib/b.ts b/lib/b.ts\n--- a/lib/b.ts\n+++ b/lib/b.ts\n@@ -1 +1 @@\n-before\n+retry here\n",
  "diff --git a/docs/My File.md b/docs/My File.md\n--- a/docs/My File.md\n+++ b/docs/My File.md\n@@ -1 +1 @@\n-draft\n+notes\n",
].join("");

async function renderFindDiff(threadRef: ScopedThreadRef, registry: AtomRegistry.AtomRegistry) {
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = { diff: FIND_DIFF };
  useDiffPanelStore.getState().selectTurn(threadRef, RunId.make("run"));
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={registry}>
        <div
          data-preview-panel-mode="embedded"
          style={{ height: 600, display: "flex", flexDirection: "column" }}
        >
          <DiffPanel
            composerDraftTarget={threadRef}
            workspaceMutationId={null}
            visible
            getShortcutContext={panelContext}
          />
        </div>
      </RegistryContext.Provider>,
    ),
  );
  await expect.element(screen.getByText("new retry retry", { exact: true })).toBeVisible();
  stack.move();
  return screen;
}

const pressFind = () =>
  userEvent.keyboard(
    navigator.platform.toLowerCase().includes("mac") ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
  );
const findInput = () => page.getByPlaceholder("Search", { exact: true });
// Pierre's find input lives in its panel's shadow root.
const findHasFocus = () =>
  expect(document.activeElement?.shadowRoot?.activeElement).toBe(findInput().element());

it("opens and closes find in the diff from its toolbar button", async () => {
  using context = setup("origin/orphan");
  await using screen = await renderFindDiff(context.threadRef, context.registry);
  const findToggle = screen.getByRole("button", { name: "Find in diff" });
  await userEvent.click(findToggle);
  await vi.waitFor(findHasFocus);
  await expect.element(findToggle).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(findInput()).not.toBeInTheDocument();
  await expect.element(findToggle).toHaveAttribute("aria-pressed", "false");
});

it("filters the Files list by the typed name and closes on Escape from its controls", async () => {
  using context = setup("origin/orphan");
  state.realFileTree = true;
  const reachedDocument = vi.fn((event: KeyboardEvent) => event.key);
  document.addEventListener("keydown", reachedDocument);
  using _listener = {
    [Symbol.dispose]: () => document.removeEventListener("keydown", reachedDocument),
  };
  await using screen = await renderFindDiff(context.threadRef, context.registry);
  await userEvent.click(screen.getByRole("button", { name: "Show file tree" }));
  const otherFile = screen.getByRole("treeitem", { name: /b\.ts/ });
  await userEvent.click(otherFile);
  await pressFind();
  const search = screen.getByRole("searchbox", { name: "Filter files by name" });
  await expect.element(search).toHaveFocus();
  await expect.element(findInput()).not.toBeInTheDocument();
  await userEvent.type(search, "My File");
  await expect.element(search).toHaveValue("My File");
  await expect.element(otherFile).not.toBeInTheDocument();
  const filteredRow = screen.getByRole("treeitem", { name: /My File\.md/ });
  await expect.element(filteredRow).toBeVisible();
  // Pierre's tree clears its own filter on Escape from a row and stops the key there.
  (filteredRow.element() as HTMLElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(screen.getByText("No matching files.")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("treeitem", { name: /b\.ts/ })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Search files" }));
  await userEvent.type(search, "My File");
  screen.getByRole("button", { name: "Name" }).element().focus();
  reachedDocument.mockClear();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(screen.getByRole("treeitem", { name: /b\.ts/ })).toBeVisible();
  // The right panel sheet closes itself on an Escape that reaches the document.
  expect(reachedDocument.mock.results.map((result) => result.value)).not.toContain("Escape");
});

it("lists the diff find's matches by file in Contents mode and jumps to a clicked line", async () => {
  using context = setup("origin/orphan");
  state.realFileTree = true;
  await using screen = await renderFindDiff(context.threadRef, context.registry);
  await userEvent.click(screen.getByRole("button", { name: "Show file tree" }));
  await userEvent.click(screen.getByRole("button", { name: "Search files" }));
  await userEvent.click(screen.getByRole("button", { name: "Contents" }));
  const contents = screen.getByRole("searchbox", { name: "Search lines in the diff" });
  await userEvent.type(contents, "retry");
  await expect.element(contents).toHaveFocus();
  // The stacked diff shows the context line once: 1 context, 1 removed and 2 added in a.ts.
  await expect.element(findInput()).toHaveValue("retry");
  await expect.element(page.getByText("1 of 5", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByRole("tree")).not.toBeInTheDocument();
  const fileA = screen.getByRole("region", { name: "src/a.ts" });
  const fileB = screen.getByRole("region", { name: "lib/b.ts" });
  const fileCount = (file: typeof fileA) =>
    file.element().querySelector("[data-diff-find-file-count]")?.textContent;
  await vi.waitFor(() => {
    expect(fileCount(fileA)).toBe("4");
    expect(fileCount(fileB)).toBe("1");
  });
  await expect
    .element(fileB.getByRole("button", { name: /retry here/ }))
    .toHaveAttribute("aria-current", "true");
  const addedLine = fileA.getByRole("button", { name: /new retry retry/ });
  await userEvent.click(addedLine);
  await expect.element(page.getByText("4 of 5", { exact: true })).toBeInTheDocument();
  await expect.element(addedLine).toHaveAttribute("aria-current", "true");
  await userEvent.click(fileA.getByRole("button", { name: /^a\.ts/ }));
  await expect.element(page.getByText("2 of 5", { exact: true })).toBeInTheDocument();
});

it("shows the diff find's query when the Files search switches to Contents", async () => {
  using context = setup("origin/orphan");
  state.realFileTree = true;
  await using screen = await renderFindDiff(context.threadRef, context.registry);
  await userEvent.click(screen.getByRole("button", { name: "Find in diff" }));
  await userEvent.type(findInput(), "retry");
  await expect.element(page.getByText("1 of 5", { exact: true })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show file tree" }));
  await userEvent.click(screen.getByRole("button", { name: "Search files" }));
  await userEvent.click(screen.getByRole("button", { name: "Contents" }));
  await expect
    .element(screen.getByRole("searchbox", { name: "Search lines in the diff" }))
    .toHaveValue("retry");
  await expect.element(findInput()).toHaveValue("retry");
  await expect.element(screen.getByRole("region", { name: "src/a.ts" })).toBeVisible();
});

it("opens find in the diff from the right panel's tab bar without preview access", async () => {
  using context = setup("origin/orphan");
  const router = {
    state: {
      matches: [
        { routeId: "/_chat", pathname: "/", params: {} },
        {
          routeId: "/_chat/$environmentId/$threadId",
          pathname: "/environment/thread",
          params: { environmentId: "environment", threadId: "thread" },
        },
      ],
    },
  } as unknown as AnyRouter;
  using _commands = { [Symbol.dispose]: installChatRouteCommands(router) };
  const diffSurface = { id: "diff", kind: "diff" } as const;
  const noop = () => {};
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = { diff: FIND_DIFF };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"));
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <RightPanelTabs
          mode="embedded"
          // A rule only the panel's own context can satisfy.
          keybindings={mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig([
              { key: "mod+f", command: "preview.find", when: "rightPanelOpen" },
            ]),
          )}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: true,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
          surfaces={[diffSurface]}
          environmentId={context.threadRef.environmentId}
          activeSurfaceId={diffSurface.id}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map()}
          onActivate={noop}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddBrowser={noop}
          onAddBrowserInProfile={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={noop}
          onAddPullRequest={noop}
          onAddPullRequests={noop}
          onAddDevice={noop}
          browserAvailable={false}
          terminalAvailable={false}
          diffAvailable
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
        >
          <DiffPanel
            mode="embedded"
            composerDraftTarget={context.threadRef}
            workspaceMutationId={null}
            visible
            getShortcutContext={panelContext}
          />
        </RightPanelTabs>
      </div>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("new retry retry", { exact: true })).toBeVisible();
  const finds = vi.fn();
  using _finds = {
    [Symbol.dispose]: subscribePreviewAction((action) => {
      if (action === "find") finds();
    }),
  };
  const tab = screen.container.querySelector<HTMLElement>("[data-active-tab='true'] button")!;
  tab.focus();
  expect(document.activeElement).toBe(tab);
  await pressFind();
  await vi.waitFor(findHasFocus);
  await userEvent.keyboard("{Escape}");
  await expect.element(findInput()).not.toBeInTheDocument();
  screen.getByRole("button", { name: "Collapse all files" }).element().focus();
  await pressFind();
  await vi.waitFor(findHasFocus);
  expect(finds).toHaveBeenCalledTimes(2);
});
