import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  type Mission,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import {
  useProjects,
  useQuietThreadShell,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";
import type { MissionHost } from "./missions.logic";

const LOCAL = EnvironmentId.make("local");
const LAPTOP = EnvironmentId.make("env-laptop");
const project = (id: string): Project => ({
  id: ProjectId.make(id),
  environmentId: LOCAL,
  title: id,
  workspaceRoot: `/projects/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
});
const web = project("web");
const api = project("api");
const shell = (
  id: string,
  title: string,
  options: { settled?: boolean; snoozed?: boolean; in?: Project } = {},
) =>
  makeThreadFixture({
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: (options.in ?? web).id,
    title,
    ...(options.settled === true
      ? { settledOverride: "settled", settledAt: "2026-01-01T00:00:00.000Z" }
      : {}),
    ...(options.snoozed === true
      ? { snoozedAt: "2026-01-01T00:00:00.000Z", snoozedUntil: "2999-01-01T00:00:00.000Z" }
      : {}),
  });
const ref = (environmentId: EnvironmentId, threadId: string) => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});
const ship: Mission = {
  missionId: "0123456789ab",
  name: "Plan the v2 release",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [
    { ref: ref(LOCAL, "lead"), role: "lead", state: "active" },
    { ref: ref(LOCAL, "docs"), role: "member", state: "active" },
    { ref: ref(LOCAL, "done"), role: "member", state: "active" },
    { ref: ref(LAPTOP, "ios"), role: "member", state: "add-pending" },
    { ref: ref(LOCAL, "guide"), role: "member", state: "add-pending" },
    { ref: ref(LOCAL, "refused"), role: "member", state: "add-refused", detail: "Laptop refused." },
    { ref: ref(LOCAL, "api-docs"), role: "member", state: "active" },
  ],
};
const gone: Mission = {
  missionId: "ba9876543210",
  name: "Old work",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [{ ref: ref(LOCAL, "deleted-lead"), role: "lead", state: "deleted" }],
};
const archived: Mission = {
  missionId: "cccccccccccc",
  name: "Archive the old site",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [{ ref: ref(LOCAL, "old-lead"), role: "lead", state: "active" }],
};
const hosts: ReadonlyArray<MissionHost> = [
  { environmentId: LOCAL, snapshot: { missions: [ship, gone, archived], links: [], claims: [] } },
];
const shells = (options: { leadSettled?: boolean; docsSnoozed?: boolean } = {}) => [
  shell("lead", "Plan the v2 release", { settled: options.leadSettled === true }),
  shell("docs", "Update the release notes", { snoozed: options.docsSnoozed === true }),
  shell("done", "Fix the changelog", { settled: true }),
  shell("plain", "Unrelated bug"),
  shell("guide", "Write the migration guide"),
  shell("refused", "Refused add thread"),
  shell("api-docs", "Document the API", { in: api }),
];

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock("../../localApi", { spy: true });
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig(
        [1, 2, 3, 4, 5, 6].map((index) => ({
          key: `mod+${index}`,
          command: `thread.jump.${index}` as "thread.jump.1",
        })),
      ),
    ),
    serverEnvironment: {
      ...actual.serverEnvironment,
      missionsLiveAcross: () => Atom.make([...hosts]),
    },
  };
});
vi.mock("./SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

async function renderSidebar(
  settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {},
  options: {
    leadSettled?: boolean;
    docsSnoozed?: boolean;
    scope?: Project;
    /** Threads the stream brings in later, by `arrive`. */
    later?: ReadonlyArray<ReturnType<typeof shell>>;
  } = {},
) {
  const previousSettings = getClientSettings();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  onTestFinished(() => __setClientSettingsForTests(previousSettings));
  useUiStateStore.setState({
    missionExpandedById: {},
    sidebarProjectScopeKeys:
      options.scope === undefined
        ? []
        : [
            deriveLogicalProjectKeyFromSettings(
              options.scope,
              selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
            ),
          ],
  });
  onTestFinished(() => useUiStateStore.setState({ sidebarProjectScopeKeys: [] }));
  vi.mocked(useProjects).mockReturnValue([web, api]);
  const listed = [...shells(options)];
  vi.mocked(useQuietThreadShells).mockImplementation(() => [...listed]);
  vi.mocked(useQuietThreadShell).mockImplementation(
    (target) =>
      listed.find(
        (thread) => thread.environmentId === target?.environmentId && thread.id === target.threadId,
      ) ?? null,
  );
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        LOCAL,
        {
          scratchWorkspaceRoot: null,
          environment: { capabilities: {} },
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: null,
  });
  const ui = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  const screen = await render(ui());
  return Object.assign(screen, {
    arrive: () => {
      listed.push(...(options.later ?? []));
      return screen.rerender(ui());
    },
  });
}

const rowTitles = (root: Element) =>
  [...root.querySelectorAll("[data-sidebar-row]")].map((row) => row.getAttribute("aria-label"));
const rowOf = (root: Element, title: string) =>
  [...root.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find((row) =>
    row.textContent?.includes(title),
  )!;
/** The thread jump each listed title shows while Ctrl is held, or null. */
const jumpsOf = (root: Element, titles: ReadonlyArray<string>) =>
  titles.map((title) => {
    const row =
      title === "draft"
        ? root.querySelector("[data-testid=sidebar-draft-row]")
        : rowOf(root, title);
    return [title, row?.textContent?.match(/Ctrl\+\d/)?.[0] ?? null];
  });

describe("missions in the sidebar", () => {
  it("heads each mission with its lead's row and lists unsettled members under it only", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Update the release notes");
    // A pending add this client has the thread for: its own row, with the pending state under it.
    expect(members.textContent).toContain("Write the migration guide");
    expect(screen.getByText("Add pending (machine offline)").elements()).toHaveLength(2);
    // The settled member is back on the Settled shelf, and no thread shows twice.
    expect(members.textContent).not.toContain("Fix the changelog");
    for (const title of [
      "Plan the v2 release",
      "Update the release notes",
      "Write the migration guide",
      "Unrelated bug",
    ]) {
      expect(screen.getByText(title, { exact: true }).elements()).toHaveLength(1);
    }
    expect(screen.getByText("Lead deleted").elements()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Missions" }).elements()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Threads" }).elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Forget" }).elements()).toHaveLength(2);
  });

  it("shows a refused add as its refusal only, and the thread once, in the usual lists", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Refused add thread")).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Laptop refused.");
    expect(members.textContent).not.toContain("Refused add thread");
    expect(screen.getByText("Refused add thread").elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Dismiss" }).elements()).toHaveLength(1);
  });

  it("reads in a lead the shell left out, and names its row for the mission meanwhile", async () => {
    using mount = vi.spyOn(threadFamilies, "mount");
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Archive the old site")).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(expect.anything(), LOCAL, "old-lead");
    expect(mount.mock.calls.map((call) => call[2])).not.toContain("lead");
  });

  it("numbers missions before drafts, in screen order, and skips folded members", async () => {
    const initial = useComposerDraftStore.getState();
    onTestFinished(() => {
      useComposerDraftStore.setState(initial, true);
    });
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const draftId = DraftId.make("unsent-draft");
    initial.setProjectDraftThreadId(scopeProjectRef(LOCAL, web.id), draftId, {
      threadId: ThreadId.make("unsent-draft-thread"),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    initial.setPrompt(draftId, "Unsent prompt");
    await using screen = await renderSidebar();
    await expect.element(screen.getByTestId("sidebar-draft-row")).toBeInTheDocument();
    const titles = ["Plan the v2 release", "Update the release notes", "Write the migration guide"];
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+5")).toBeVisible();
    expect(jumpsOf(screen.container, [...titles, "Document the API", "draft"])).toEqual([
      ["Plan the v2 release", "Ctrl+1"],
      ["Update the release notes", "Ctrl+2"],
      ["Write the migration guide", "Ctrl+3"],
      ["Document the API", "Ctrl+4"],
      ["draft", "Ctrl+5"],
    ]);
    await userEvent.keyboard("{/Control}");
    const [collapse] = screen.getByRole("button", { name: "Collapse mission" }).elements();
    await act(() => (collapse as HTMLElement).click());
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+2")).toBeVisible();
    expect(jumpsOf(screen.container, ["Plan the v2 release", "draft"])).toEqual([
      ["Plan the v2 release", "Ctrl+1"],
      ["draft", "Ctrl+2"],
    ]);
    await userEvent.keyboard("{/Control}");
  });

  it("with a project scope, lists only members in it, under a lead that takes no jump", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await renderSidebar({}, { scope: api });
    await expect.element(screen.getByText("Document the API")).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Document the API");
    expect(members.textContent).not.toContain("Update the release notes");
    expect(screen.getByText("Lead deleted").elements()).toHaveLength(0);
    // Its lead is still on its way, so only its project can rule it out.
    expect(screen.getByText("Archive the old site").elements()).toHaveLength(1);
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+1")).toBeVisible();
    expect(jumpsOf(screen.container, ["Plan the v2 release", "Document the API"])).toEqual([
      ["Plan the v2 release", null],
      ["Document the API", "Ctrl+1"],
    ]);
    await userEvent.keyboard("{/Control}");
  });

  it("keeps a scoped mission while its lead is read in, and shows the lead once it arrives", async () => {
    using mount = vi.spyOn(threadFamilies, "mount");
    await using screen = await renderSidebar(
      {},
      { scope: web, later: [shell("old-lead", "Archive the old site", { settled: true })] },
    );
    await expect.element(screen.getByText("Archive the old site")).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(expect.anything(), LOCAL, "old-lead");
    await screen.arrive();
    await expect
      .element(screen.getByText("Archive the old site", { exact: true }))
      .toBeInTheDocument();
    expect(screen.container.querySelector('[data-thread-item="local:old-lead"]')).not.toBeNull();
  });

  it("keeps a snoozed member in its mission, with Wake on the row and in the menu", async () => {
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    await using screen = await renderSidebar({}, { docsSnoozed: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    const row = rowOf(members, "Update the release notes");
    expect(row.closest("li")!.querySelector('[aria-label="Wake thread now"]')).not.toBeNull();
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const ids = (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map(
      (item) => item.id,
    );
    expect(ids).toContain("unsnooze");
  });

  it("offers a settled lead Un-settle, and a member Release from mission", async () => {
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    await using screen = await renderSidebar({}, { leadSettled: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const idsFor = async (title: string) => {
      show.mockClear();
      await userEvent.click(rowOf(screen.container, title), { button: "right" });
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      return (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map(
        (item) => item.id,
      );
    };
    const leadItems = await idsFor("Plan the v2 release");
    expect(leadItems).toContain("unsettle");
    expect(leadItems).not.toContain("settle");
    expect(await idsFor("Update the release notes")).toContain(
      "mission-release:local:0123456789ab",
    );
  });

  it("heads a mission with the lead's title beside its chevron, and names no project", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
    const lead = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    expect(lead.textContent).not.toMatch(/web|WB/);
    const chevron = lead.querySelector<HTMLElement>('[aria-label="Collapse mission"]')!;
    expect(chevron.parentElement!.textContent).toContain("Plan the v2 release");
    // Members keep their own project.
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(rowOf(members, "Update the release notes").textContent).toContain("web");
    // The fallback leads have the same shape: chevron and title, no project.
    for (const title of ["Lead deleted", "Archive the old site"]) {
      const line = screen.getByText(title, { exact: true }).element().closest("li")!;
      expect(line.querySelector('[aria-label="Collapse mission"]')).not.toBeNull();
      expect(line.textContent).not.toMatch(/web|WB/);
    }

    await userEvent.click(screen.getByText("Plan the v2 release", { exact: true }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ threadId: "lead" }) }),
    );
    navigate.mockClear();
    await act(() => chevron.click());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Update the release notes").elements()).toHaveLength(0);
  });

  it("folds one mission away and remembers it, leaving the others open", async () => {
    await using screen = await renderSidebar();
    const [collapse] = screen.getByRole("button", { name: "Collapse mission" }).elements();
    await act(() => (collapse as HTMLElement).click());
    expect(screen.container.querySelector("[data-testid=sidebar-mission-members]")).toBeNull();
    expect(screen.getByText("Update the release notes").elements()).toHaveLength(0);
    expect(useUiStateStore.getState().missionExpandedById).toEqual({
      "local:0123456789ab": false,
    });
    expect(screen.getByRole("button", { name: "Expand mission" }).elements()).toHaveLength(1);
  });

  it("lists every thread as usual when Missions is off", async () => {
    await using screen = await renderSidebar({ sidebarMissionsEnabled: false });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    expect(screen.container.querySelector("[data-testid=sidebar-mission-members]")).toBeNull();
    expect(screen.getByRole("heading").elements()).toHaveLength(0);
    expect(
      rowTitles(screen.container).filter((title) => title?.includes("Plan the v2")),
    ).toHaveLength(1);
  });

  it("hides both headings when their settings are off", async () => {
    await using screen = await renderSidebar({
      sidebarMissionsHeaderVisible: false,
      sidebarThreadsHeaderVisible: false,
    });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    expect(screen.getByRole("heading").elements()).toHaveLength(0);
  });
});
