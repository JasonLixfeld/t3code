import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type Mission,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";
import type { MissionHost } from "./missions.logic";

const LOCAL = EnvironmentId.make("local");
const LAPTOP = EnvironmentId.make("env-laptop");
const web: Project = {
  id: ProjectId.make("web"),
  environmentId: LOCAL,
  title: "web",
  workspaceRoot: "/projects/web",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};
const shell = (id: string, title: string, settled = false) =>
  makeThreadFixture({
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: web.id,
    title,
    ...(settled ? { settledOverride: "settled", settledAt: "2026-01-01T00:00:00.000Z" } : {}),
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
  ],
};
const gone: Mission = {
  missionId: "ba9876543210",
  name: "Old work",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [{ ref: ref(LOCAL, "deleted-lead"), role: "lead", state: "deleted" }],
};
const hosts: ReadonlyArray<MissionHost> = [
  { environmentId: LOCAL, snapshot: { missions: [ship, gone], links: [], claims: [] } },
];

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
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

async function renderSidebar(settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {}) {
  const previousSettings = getClientSettings();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  useUiStateStore.setState({ missionExpandedById: {} });
  vi.mocked(useProjects).mockReturnValue([web]);
  vi.mocked(useQuietThreadShells).mockReturnValue([
    shell("lead", "Plan the v2 release"),
    shell("docs", "Update the release notes"),
    shell("done", "Fix the changelog", true),
    shell("plain", "Unrelated bug"),
    shell("guide", "Write the migration guide"),
  ]);
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([[LOCAL, { scratchWorkspaceRoot: null } as unknown as EnvironmentServerConfig]]),
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
  onTestFinished(() => __setClientSettingsForTests(previousSettings));
  return render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
}

const rowTitles = (root: Element) =>
  [...root.querySelectorAll("[data-sidebar-row]")].map((row) => row.getAttribute("aria-label"));

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
