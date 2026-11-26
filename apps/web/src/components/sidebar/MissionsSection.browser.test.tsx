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
  type MissionMember,
  MissionError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { openCommandPalette } from "../../commandPaletteBus";
import { readLocalApi } from "../../localApi";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  useProjects,
  useQuietThreadShell,
  readThreadShell,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { toastManager } from "../ui/toast";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import Sidebar from "../Sidebar";
import { MissionPromptDialog } from "./MissionsSection";
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
  options: { settled?: boolean; snoozed?: boolean; in?: Project; empty?: boolean } = {},
) =>
  makeThreadFixture({
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: (options.in ?? web).id,
    title,
    ...(options.empty === true
      ? {}
      : { latestUserMessageAt: "2026-01-01T00:00:00.000Z", visibleItemCount: 1 }),
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
/** A test may list one more mission, for itself only. */
const listedMissions: Array<Mission> = [ship, gone, archived];
/** The claims this machine holds, which a test may add to for itself. */
const listedClaims: Array<MissionHost["snapshot"]["claims"][number]> = [];
const hosts: Array<MissionHost> = [
  { environmentId: LOCAL, snapshot: { missions: listedMissions, links: [], claims: listedClaims } },
];
/** Machines whose missions this client may not change, which a test may add to for itself. */
const readOnly = new Set<EnvironmentId>();
const permissions = new Map<string, ReturnType<typeof Atom.make<boolean>>>();
const mayChange = (environmentId: EnvironmentId) => {
  const key = `${environmentId}:${readOnly.has(environmentId)}`;
  const atom = permissions.get(key) ?? Atom.make(!readOnly.has(environmentId));
  permissions.set(key, atom);
  return atom;
};
/** The mission commands the sidebar sends, by the label it sends them under. */
const commands = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const commandFor = (label: string) => {
  const existing = commands.get(label);
  if (existing !== undefined) return existing;
  const command = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.set(label, command);
  return command;
};
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
vi.mock("../../commandPaletteBus", { spy: true });
vi.mock("../../state/environments", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: never, options?: string) =>
      typeof options === "string" && options.startsWith("mission ")
        ? commandFor(options)
        : actual.useAtomCommand(command, options)) as never,
  };
});
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
      // This client may change the missions every machine keeps, unless a test says otherwise.
      addMissionMember: Object.assign(actual.serverEnvironment.addMissionMember, {
        permissionAtom: (environmentId: EnvironmentId) => mayChange(environmentId),
      }),
      releaseMissionMember: Object.assign(actual.serverEnvironment.releaseMissionMember, {
        permissionAtom: (environmentId: EnvironmentId) => mayChange(environmentId),
      }),
      setMissionLead: Object.assign(actual.serverEnvironment.setMissionLead, {
        permissionAtom: () => Atom.make(true),
      }),
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
    /** More threads, listed from the start. */
    extra?: ReadonlyArray<ReturnType<typeof shell>>;
    /** Threads left out of the stream, by id. */
    without?: ReadonlyArray<string>;
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
  const listed = [...shells(options), ...(options.extra ?? [])].filter(
    (thread) => !(options.without ?? []).includes(thread.id),
  );
  commands.clear();
  vi.mocked(useQuietThreadShells).mockImplementation(() => [...listed]);
  vi.mocked(useQuietThreadShell).mockImplementation(
    (target) =>
      listed.find(
        (thread) => thread.environmentId === target?.environmentId && thread.id === target.threadId,
      ) ?? null,
  );
  vi.mocked(readThreadShell).mockImplementation(
    (target) =>
      listed.find(
        (thread) => thread.environmentId === target.environmentId && thread.id === target.threadId,
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
      <MissionPromptDialog />
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
    expect(screen.container.querySelector('[aria-label="New mission"]')).toBeNull();
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

  it("shows a member's pending leave as Leave pending", async () => {
    listedMissions[0] = {
      ...ship,
      members: [
        ...ship.members,
        { ref: ref(LOCAL, "plain"), role: "member", state: "release-pending" },
      ],
    };
    onTestFinished(() => {
      listedMissions[0] = ship;
    });
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Leave pending (machine offline)")).toBeInTheDocument();
  });

  it("shows a refused release with why, and offers Dismiss and Retry", async () => {
    listedMissions[0] = {
      ...ship,
      members: [
        ...ship.members,
        {
          ref: ref(LOCAL, "plain"),
          role: "member",
          state: "release-refused",
          detail: "The laptop refused it.",
        },
      ],
    };
    onTestFinished(() => {
      listedMissions[0] = ship;
    });
    await using screen = await renderSidebar();
    await expect
      .element(screen.getByText("Leave refused: The laptop refused it."))
      .toBeInTheDocument();
    // Still a member: its thread shows under the mission, with the refusal under its row.
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Unrelated bug");
    const command = {
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "plain") },
    };
    const refusal = screen.getByText("Leave refused: The laptop refused it.").element();
    const button = (name: string) =>
      refusal.parentElement!.querySelector<HTMLElement>(`button[aria-label="${name}"]`)!;
    button("Retry").click();
    await vi.waitFor(() =>
      expect(commandFor("mission release member")).toHaveBeenCalledExactlyOnceWith(command),
    );
    await vi.waitFor(() => expect(button("Dismiss").hasAttribute("disabled")).toBe(false));
    button("Dismiss").click();
    await vi.waitFor(() =>
      expect(commandFor("mission forget member")).toHaveBeenCalledExactlyOnceWith(command),
    );
  });

  it("reads in a lead the shell left out, and names its row for the mission meanwhile", async () => {
    using mount = vi.spyOn(threadFamilies, "mount");
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Archive the old site")).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(expect.anything(), LOCAL, "old-lead");
    expect(mount.mock.calls.map((call) => call[2])).not.toContain("lead");
  });

  it("numbers missions before drafts, in screen order, and skips folded members", async () => {
    const previous = useComposerDraftStore.getState();
    onTestFinished(() => {
      useComposerDraftStore.setState(previous, true);
    });
    // Drafts other test files saved in this origin's storage would take numbers too.
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    const initial = useComposerDraftStore.getState();
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
    const collapse = screen.container.querySelector<HTMLElement>(
      '[aria-label^="Collapse mission"]',
    )!;
    await act(() => collapse.click());
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

  it("names the lead's row without a project, and its chevron with the mission and its size", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const lead = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    expect(lead.getAttribute("aria-label")).toBe("Plan the v2 release");
    expect(
      screen.getByRole("button", {
        name: "Collapse mission Plan the v2 release, 5 threads",
        exact: true,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse mission Archive the old site, 0 threads" }),
    ).toBeInTheDocument();
    // A member's row still names its project.
    expect(
      screen.container.querySelector('[data-sidebar-row="local:docs"]')!.getAttribute("aria-label"),
    ).toBe("Update the release notes, web");
  });

  it("sweeps Settle from the lead over its members in the same state only", async () => {
    await using screen = await renderSidebar({}, { docsSnoozed: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const lead = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    const docs = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:docs"]')!;
    const settle = lead.querySelector<HTMLElement>('[aria-label="Settle thread"]')!;
    const at = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return { clientX: box.left + 4, clientY: box.top + box.height / 2 };
    };
    const pointer = (type: string, target: EventTarget, values: PointerEventInit) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          buttons: 1,
          ...values,
        }),
      );
    await act(() => pointer("pointerdown", settle, at(settle)));
    await act(() =>
      pointer("pointermove", document, { ...at(settle), clientY: at(settle).clientY + 20 }),
    );
    await act(() => pointer("pointermove", document, at(docs)));
    const swept = [...screen.container.querySelectorAll<HTMLElement>("[data-sidebar-row]")]
      .filter((row) => row.querySelector('[role="status"]')?.textContent === "Settle")
      .map((row) => row.dataset.sidebarRow);
    await act(() => pointer("pointercancel", document, at(docs)));
    expect(swept).toEqual(["local:lead"]);
  });

  it("stops waiting for a lead its family read did not bring, as for an archived lead", async () => {
    // A lead no other test reads, so no earlier read of it is still held.
    listedMissions.push({
      missionId: "dddddddddddd",
      name: "Retired work",
      createdAt: "2026-11-23T00:00:00.000Z",
      members: [{ ref: ref(LOCAL, "archived-lead"), role: "lead", state: "active" }],
    });
    onTestFinished(() => {
      listedMissions.pop();
    });
    using _family = vi
      .spyOn(threadFamilies, "familyAtom")
      .mockImplementation(() => Atom.make(AsyncResult.success({ threads: [] })) as never);
    await using scoped = await renderSidebar({}, { scope: api });
    await expect.element(scoped.getByText("Document the API")).toBeInTheDocument();
    await vi.waitFor(() => expect(scoped.container.textContent).not.toContain("Retired work"));
  });

  it("offers Wake for a snoozed member found by search while its mission is folded", async () => {
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    await using screen = await renderSidebar({}, { docsSnoozed: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const collapse = screen.container.querySelector<HTMLElement>(
      '[aria-label^="Collapse mission"]',
    )!;
    // A real click: an earlier sweep's click guard on the document would swallow a bare one.
    await userEvent.click(collapse);
    expect(screen.container.querySelector("[data-testid=sidebar-mission-members]")).toBeNull();
    await userEvent.fill(screen.getByLabelText("Search threads"), "release notes");
    const result = screen.getByText("Update the release notes").first();
    await expect.element(result).toBeInTheDocument();
    await userEvent.click(result, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const ids = (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map(
      (item) => item.id,
    );
    expect(ids).toContain("unsnooze");
  });

  it("offers a settled lead Un-settle, and a member Leave mission", async () => {
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

  /** Right-clicks Update the release notes, a member of the v2 mission, and picks `pick`. */
  const memberMenu = async (pick: string | null, confirmed = true) => {
    const show = vi.fn().mockResolvedValue(pick);
    const confirm = vi.fn().mockResolvedValue(confirmed);
    vi.mocked(readLocalApi).mockReturnValue({
      contextMenu: { show },
      dialogs: { confirm },
    } as unknown as LocalApi);
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    await userEvent.click(rowOf(screen.container, "Update the release notes"), { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    await act(async () => {});
    return {
      ids: (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map(
        (item) => item.id,
      ),
      confirm,
    };
  };
  const claimDocs = (missionId: string) => {
    listedClaims.push({ threadId: ThreadId.make("docs"), missionId, name: "Elsewhere" });
    onTestFinished(() => {
      listedClaims.length = 0;
    });
  };

  it("leaves from a row's menu only the mission the row is under, not another claim", async () => {
    // Listed under the v2 mission, while this machine reports the thread in another one.
    claimDocs("ffffffffffff");
    const { ids } = await memberMenu(null);
    expect(ids).toContain("mission-release:local:0123456789ab");
    expect(ids.filter((id) => id.startsWith("mission-leave:"))).toEqual([]);
  });

  it("sends no leave when the menu's confirmation is cancelled, and the row's mission when not", async () => {
    claimDocs(ship.missionId);
    const pick = "mission-leave:local:0123456789ab";
    const cancelled = await memberMenu(pick, false);
    expect(cancelled.ids).toContain(pick);
    expect(cancelled.confirm).toHaveBeenCalledTimes(1);
    expect(commandFor("mission leave")).not.toHaveBeenCalled();
    await memberMenu(pick, true);
    await vi.waitFor(() =>
      expect(commandFor("mission leave")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { threadId: "docs", missionId: ship.missionId },
      }),
    );
  });

  it("gives every mission row T3's menu with the mission's group", async () => {
    const show = vi.fn().mockResolvedValue(null);
    const confirm = vi.fn().mockResolvedValue(true);
    vi.mocked(readLocalApi).mockReturnValue({
      contextMenu: { show },
      dialogs: { confirm },
    } as unknown as LocalApi);
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Lead deleted")).toBeInTheDocument();
    const menuOf = async (row: HTMLElement, pick: string | null) => {
      show.mockClear();
      show.mockResolvedValueOnce(pick);
      await userEvent.click(row, { button: "right" });
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      return (show.mock.lastCall![0] as ReadonlyArray<{ readonly label: string }>).map(
        (item) => item.label,
      );
    };
    // The live lead's thread menu keeps its own items, then the mission's group.
    const lead = await menuOf(rowOf(screen.container, "Plan the v2 release"), null);
    expect(lead).toContain("Pin thread");
    const group = lead.indexOf("Mission");
    expect(lead.slice(group, group + 4)).toEqual([
      "Mission",
      "New thread in this mission",
      "Edit mission prompt…",
      "Delete mission",
    ]);
    // A lead cannot start, join or leave a mission, so those are not offered.
    for (const absent of ["Start mission from this thread", "Add to mission", "Leave mission"]) {
      expect(lead).not.toContain(absent);
    }
    // A member keeps them.
    const member = await menuOf(rowOf(screen.container, "Update the release notes"), null);
    expect(member).toEqual(expect.arrayContaining(["Leave mission", "Add to mission"]));
    expect(member).not.toContain("New thread in this mission");
    // A deleted lead's row also takes a new lead.
    const gone = screen.getByText("Lead deleted").element().closest("li")!;
    expect(await menuOf(gone, "mission-new-thread:local:ba9876543210")).toEqual([
      "Mission",
      "New thread in this mission",
      "Edit mission prompt…",
      "New lead",
      "Choose a thread…",
      "Delete mission",
    ]);
    await vi.waitFor(() =>
      expect(openCommandPalette).toHaveBeenCalledWith({
        open: "new-thread-in",
        mission: { kind: "member", host: LOCAL, missionId: "ba9876543210", name: "Old work" },
      }),
    );
    // A lead not read in yet, as an archived one, still gets the menu, a new lead, and delete.
    const loading = screen.getByText("Archive the old site").element().closest("li")!;
    expect(await menuOf(loading, "mission-delete:local:cccccccccccc")).toEqual([
      "Mission",
      "New thread in this mission",
      "Edit mission prompt…",
      "New lead",
      "Choose a thread…",
      "Delete mission",
    ]);
    await vi.waitFor(() =>
      expect(commandFor("mission delete")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { missionId: "cccccccccccc" },
      }),
    );
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("edits a mission's prompt from its menu, starting from the one it has", async () => {
    const show = vi.fn().mockResolvedValue("mission-prompt:local:0123456789ab");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    listedMissions[0] = { ...ship, prompt: "Ship it." };
    onTestFinished(() => {
      listedMissions[0] = ship;
    });
    await using screen = await renderSidebar();
    await userEvent.click(rowOf(screen.container, "Plan the v2 release"), { button: "right" });
    const prompt = page.getByRole("textbox", { name: "Mission prompt" });
    await expect.element(prompt).toHaveValue("Ship it.");
    await userEvent.fill(prompt, "Review every pull request.");
    // In this unstyled render the modal's inert layer covers its buttons, so click the button itself.
    (page.getByRole("button", { name: "Save" }).element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(commandFor("mission set prompt")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { missionId: "0123456789ab", prompt: "Review every pull request." },
      }),
    );
    await expect.element(prompt).not.toBeInTheDocument();
  });

  it("heads a mission with the lead's title beside its chevron, and names no project", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
    const lead = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    expect(lead.textContent).not.toMatch(/web|WB/);
    const chevron = lead.querySelector<HTMLElement>('[aria-label^="Collapse mission"]')!;
    expect(chevron.parentElement!.textContent).toContain("Plan the v2 release");
    // The row's title is the lead's title alone, with no word put before it.
    expect(chevron.nextElementSibling!.textContent).toBe("Plan the v2 release");
    // With no status, machine or provider to show, the row is that one line.
    expect(chevron.parentElement!.nextElementSibling).toBeNull();
    // Members keep their own project.
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    // A pending add is the last line of its own member's row.
    expect(rowOf(members, "Write the migration guide").textContent).toContain(
      "Add pending (machine offline)",
    );
    expect(rowOf(members, "Update the release notes").textContent).toContain("web");
    // The fallback leads have the same shape: chevron and title, no project.
    for (const title of ["Lead deleted", "Archive the old site"]) {
      const line = screen.getByText(title, { exact: true }).element().closest("li")!;
      expect(line.querySelector('[aria-label^="Collapse mission"]')).not.toBeNull();
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
    const collapse = screen.container.querySelector<HTMLElement>(
      '[aria-label^="Collapse mission"]',
    )!;
    await act(() => collapse.click());
    expect(screen.container.querySelector("[data-testid=sidebar-mission-members]")).toBeNull();
    expect(screen.getByText("Update the release notes").elements()).toHaveLength(0);
    expect(useUiStateStore.getState().missionExpandedById).toEqual({
      "local:0123456789ab": false,
    });
    expect(screen.container.querySelectorAll('[aria-label^="Expand mission"]')).toHaveLength(1);
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

  it("keeps the Threads heading and offers no New mission button when the Missions heading is off", async () => {
    await using screen = await renderSidebar({ sidebarMissionsHeaderVisible: false });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Missions" }).elements()).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Threads" }).elements()).toHaveLength(1);
    expect(screen.container.querySelector('[aria-label="New mission"]')).toBeNull();
  });
});

/** Rows drag only on a connected machine this client may operate. */
function allowDrag(): Disposable {
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  return {
    [Symbol.dispose]: () => {
      vi.mocked(useConnectedEnvironmentIds).mockReset();
      vi.mocked(useEnvironmentScope).mockReset();
    },
  };
}

/** A pointer drag from one element to another, as the sidebar's drag sees it. */
/** An element, a point, or one the drag itself shows, found when the pointer gets there. */
type DragTarget =
  | HTMLElement
  | { readonly clientX: number; readonly clientY: number }
  | (() => HTMLElement | { readonly clientX: number; readonly clientY: number });

async function dragBetween(from: HTMLElement, to: DragTarget) {
  const center = (target: DragTarget) => {
    const element = typeof target === "function" ? target() : target;
    if (!(element instanceof HTMLElement)) return element;
    const box = element.getBoundingClientRect();
    return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  };
  const pointer = (type: string, target: EventTarget, values: PointerEventInit) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 1,
        button: 0,
        buttons: 1,
        ...values,
      }),
    );
  const start = center(from);
  await act(() => pointer("pointerdown", from, start));
  await act(() => pointer("pointermove", document, { ...start, clientY: start.clientY + 12 }));
  await act(() => pointer("pointermove", document, { ...start, clientY: start.clientY + 16 }));
  await act(() => pointer("pointermove", document, center(to)));
  // The pointer is let go where it last moved to.
  let at = to;
  return {
    moveTo: (next: DragTarget) => {
      at = next;
      return act(() => pointer("pointermove", document, center(next)));
    },
    release: async () => {
      await act(() => pointer("pointerup", document, { ...center(at), buttons: 0 }));
      // A drag leaves a guard for its click; the next press clears it.
      await act(() => pointer("pointerdown", document.body, { clientX: 0, clientY: 0 }));
      await act(() => pointer("pointerup", document.body, { clientX: 0, clientY: 0, buttons: 0 }));
    },
  };
}

const releaseZone = (root: Element) => () =>
  root.querySelector<HTMLElement>('[data-mission-release="zone"]')!;
const shipArea = (root: Element) =>
  root.querySelector<HTMLElement>('[data-mission-drop="local:0123456789ab"]')!;
const hintIn = (element: Element) => element.querySelector('[role="status"]')?.textContent ?? null;

describe("dragging threads into and out of missions", () => {
  it("adds a dragged thread to the mission it is dropped on", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    expect(hintIn(shipArea(screen.container))).toBe("Add to mission");
    await drag.release();
    expect(commandFor("mission add member")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "plain") },
    });
    expect(hintIn(shipArea(screen.container))).toBeNull();
  });

  it("shows why a thread cannot join, does not drop it, and says why in a toast", async () => {
    using _drag = allowDrag();
    listedClaims.push({ threadId: ThreadId.make("plain"), missionId: "ffffffffffff", name: "X" });
    onTestFinished(() => {
      listedClaims.length = 0;
    });
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    expect(hintIn(shipArea(screen.container))).toBe("In a mission");
    await drag.release();
    expect(commandFor("mission add member")).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Not added to the mission", description: "In a mission" }),
    );
  });

  it("adds an empty thread as a member, as a lead starts one with no prompt", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar(
      {},
      { extra: [shell("empty", "Empty thread", { empty: true })] },
    );
    await expect.element(screen.getByText("Empty thread")).toBeInTheDocument();
    const drag = await dragBetween(
      rowOf(screen.container, "Empty thread"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    expect(hintIn(shipArea(screen.container))).toBe("Add to mission");
    await drag.release();
    expect(commandFor("mission add member")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "empty") },
    });
  });

  it("adds every selected thread when the drag starts on a selected one", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:plain", "local:refused"]),
    });
    onTestFinished(() => useThreadSelectionStore.setState({ selectedThreadKeys: new Set() }));
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    await drag.release();
    const added = commandFor("mission add member").mock.calls.map(
      ([call]) => (call as { input: { member: { threadId: string } } }).input.member.threadId,
    );
    expect(added.toSorted()).toEqual(["plain", "refused"]);
  });

  it("adds selected threads a folded shelf hides, with the one the drag started on", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar(
      {},
      { extra: [shell("folded", "Old settled bug", { settled: true })] },
    );
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain("Old settled bug");
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:plain", "local:folded"]),
    });
    onTestFinished(() => useThreadSelectionStore.setState({ selectedThreadKeys: new Set() }));
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    await drag.release();
    const added = commandFor("mission add member").mock.calls.map(
      ([call]) => (call as { input: { member: { threadId: string } } }).input.member.threadId,
    );
    expect(added.toSorted()).toEqual(["folded", "plain"]);
  });

  it("clears the composer's drop highlight when the drag moves on onto a mission", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    // The sidebar sits beside the composer.
    screen.container.style.width = "200px";
    const composer = document.createElement("div");
    composer.setAttribute("data-thread-context-drop", "true");
    Object.assign(composer.style, {
      position: "fixed",
      right: "0",
      top: "0",
      width: "200px",
      height: "300px",
      zIndex: "100",
    });
    document.body.append(composer);
    onTestFinished(() => composer.remove());
    const drag = await dragBetween(rowOf(screen.container, "Unrelated bug"), composer);
    expect(composer.hasAttribute("data-thread-context-over")).toBe(true);
    await drag.moveTo(rowOf(screen.container, "Plan the v2 release"));
    expect(hintIn(shipArea(screen.container))).toBe("Add to mission");
    expect(composer.hasAttribute("data-thread-context-over")).toBe(false);
    await drag.release();
  });

  it("waits for a selected thread's family read that answers late, and adds it", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    // The family read answers 300 ms after the drop; only then is the thread there.
    const older = shell("older", "Old settled bug", { settled: true });
    let answered = false;
    const listedShell = vi.mocked(readThreadShell).getMockImplementation()!;
    vi.mocked(readThreadShell).mockImplementation((target) =>
      answered && target.threadId === "older" ? older : listedShell(target),
    );
    const family = Atom.make<AsyncResult.AsyncResult<{ threads: [] }, never>>(
      AsyncResult.initial(true),
    );
    using _family = vi.spyOn(threadFamilies, "familyAtom").mockReturnValue(family as never);
    using _mount = vi.spyOn(threadFamilies, "mount").mockImplementation(() => {
      setTimeout(() => {
        answered = true;
        appAtomRegistry.set(family, AsyncResult.success({ threads: [] }));
      }, 300);
      return () => {};
    });
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:plain", "local:older"]),
    });
    onTestFinished(() => useThreadSelectionStore.setState({ selectedThreadKeys: new Set() }));
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    await drag.release();
    const added = () =>
      commandFor("mission add member").mock.calls.map(
        ([call]) => (call as { input: { member: { threadId: string } } }).input.member.threadId,
      );
    await vi.waitFor(() => expect(added().toSorted()).toEqual(["older", "plain"]));
    expect(toasts).not.toHaveBeenCalled();
  });

  it("reads in selected threads an unread older page holds, and names those it cannot", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    // An older settled page holds "older"; "lost" cannot be read at all.
    const older = shell("older", "Old settled bug", { settled: true });
    const readIn = new Set<string>();
    const listedShell = vi.mocked(readThreadShell).getMockImplementation()!;
    vi.mocked(readThreadShell).mockImplementation((target) =>
      readIn.has(target.threadId) ? older : listedShell(target),
    );
    using _family = vi
      .spyOn(threadFamilies, "familyAtom")
      .mockImplementation(() => Atom.make(AsyncResult.success({ threads: [] })) as never);
    using mount = vi.spyOn(threadFamilies, "mount").mockImplementation((_, __, threadId) => {
      if (threadId === "older") readIn.add(threadId);
      return () => {};
    });
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:plain", "local:older", "local:lost"]),
    });
    onTestFinished(() => useThreadSelectionStore.setState({ selectedThreadKeys: new Set() }));
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    await drag.release();
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenCalledWith(
        expect.objectContaining({ title: "2 added, 1 refused: Not loaded." }),
      ),
    );
    const added = commandFor("mission add member").mock.calls.map(
      ([call]) => (call as { input: { member: { threadId: string } } }).input.member.threadId,
    );
    expect(added.toSorted()).toEqual(["older", "plain"]);
    expect(mount.mock.calls.map((call) => call[2]).toSorted()).toEqual(["lost", "older"]);
  });

  it.each([
    ["with the Threads heading on", {}, {}],
    [
      "with the heading off and every thread in a mission",
      { sidebarThreadsHeaderVisible: false },
      { without: ["plain", "refused"] },
    ],
  ] as const)("releases a member dropped on the release zone %s", async (_, settings, options) => {
    using _drag = allowDrag();
    await using screen = await renderSidebar(settings, options);
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    expect(screen.container.querySelector('[data-mission-release="zone"]')).toBeNull();
    const drag = await dragBetween(
      rowOf(screen.container, "Update the release notes"),
      releaseZone(screen.container),
    );
    expect(releaseZone(screen.container)().textContent).toBe("Leave mission");
    await drag.release();
    expect(commandFor("mission release member")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "docs") },
    });
  });

  /**
   * A thread here joined a mission the laptop leads, and this machine holds its claim. "plain" is
   * Unrelated bug's row; "unread" has no thread loaded, so its member row shows instead.
   */
  const leadOnLaptop = (
    state: MissionMember["state"],
    writable: ReadonlyArray<EnvironmentId>,
    member = "plain",
  ) => {
    const launch: Mission = {
      missionId: "dddddddddddd",
      name: "Laptop launch",
      createdAt: "2026-11-23T00:00:00.000Z",
      members: [
        { ref: ref(LAPTOP, "laptop-lead"), role: "lead", state: "active" },
        { ref: ref(LOCAL, member), role: "member", state },
      ],
    };
    hosts.push({ environmentId: LAPTOP, snapshot: { missions: [launch], links: [], claims: [] } });
    listedClaims.push({
      threadId: ThreadId.make(member),
      missionId: "dddddddddddd",
      name: "Laptop launch",
    });
    for (const environmentId of [LOCAL, LAPTOP]) {
      if (!writable.includes(environmentId)) readOnly.add(environmentId);
    }
    onTestFinished(() => {
      hosts.length = 1;
      listedClaims.length = 0;
      readOnly.clear();
    });
  };
  const leaveRoutes = (member: string) =>
    [
      [
        "only the member's machine",
        [LOCAL],
        "mission leave",
        { environmentId: LOCAL, input: { threadId: member, missionId: "dddddddddddd" } },
      ],
      [
        "only the lead's machine",
        [LAPTOP],
        "mission release member",
        {
          environmentId: LAPTOP,
          input: { missionId: "dddddddddddd", member: ref(LOCAL, member) },
        },
      ],
      ["neither machine", [], null, null],
    ] as const;

  it.each(leaveRoutes("unread"))(
    "leaves at once from the row's X when %s may be changed",
    async (_, writable, label, command) => {
      leadOnLaptop("active", writable, "unread");
      const confirm = vi.fn().mockResolvedValue(true);
      vi.mocked(readLocalApi).mockReturnValue({ dialogs: { confirm } } as unknown as LocalApi);
      await using screen = await renderSidebar();
      await expect.element(screen.getByText("Laptop launch").first()).toBeInTheDocument();
      const x = screen.container.querySelector<HTMLElement>('button[aria-label="Leave mission"]')!;
      expect(x.hasAttribute("disabled")).toBe(label === null);
      x.click();
      await act(async () => {});
      for (const sent of ["mission leave", "mission release member"]) {
        if (sent === label) expect(commandFor(sent)).toHaveBeenCalledExactlyOnceWith(command);
        else expect(commandFor(sent)).not.toHaveBeenCalled();
      }
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it.each(leaveRoutes("plain"))(
    "leaves at once by a drop on the zone when %s may be changed",
    async (_, writable, label, command) => {
      leadOnLaptop("active", writable);
      const confirm = vi.fn().mockResolvedValue(true);
      vi.mocked(readLocalApi).mockReturnValue({ dialogs: { confirm } } as unknown as LocalApi);
      using _drag = allowDrag();
      await using screen = await renderSidebar();
      await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
      const drag = await dragBetween(
        rowOf(screen.container, "Unrelated bug"),
        releaseZone(screen.container),
      );
      await drag.release();
      await act(async () => {});
      for (const sent of ["mission leave", "mission release member"]) {
        if (sent === label) expect(commandFor(sent)).toHaveBeenCalledExactlyOnceWith(command);
        else expect(commandFor(sent)).not.toHaveBeenCalled();
      }
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("retries a refused leave by the route that works, here its own machine", async () => {
    leadOnLaptop("release-refused", [LOCAL], "unread");
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Laptop launch").first()).toBeInTheDocument();
    const retry = screen.container.querySelector<HTMLElement>('button[aria-label="Retry"]')!;
    expect(retry.hasAttribute("disabled")).toBe(false);
    retry.click();
    await vi.waitFor(() =>
      expect(commandFor("mission leave")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { threadId: "unread", missionId: "dddddddddddd" },
      }),
    );
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
  });

  it("keeps a pending leave as Leave pending with Forget, even with the claim still held here", async () => {
    leadOnLaptop("release-pending", [LOCAL, LAPTOP]);
    const confirm = vi.fn().mockResolvedValue(true);
    vi.mocked(readLocalApi).mockReturnValue({ dialogs: { confirm } } as unknown as LocalApi);
    await using screen = await renderSidebar();
    const pending = screen.getByText("Leave pending (machine offline)");
    await expect.element(pending).toBeInTheDocument();
    pending
      .element()
      .parentElement!.querySelector<HTMLElement>('button[aria-label="Forget"]')!
      .click();
    await vi.waitFor(() =>
      expect(commandFor("mission forget member")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LAPTOP,
        input: { missionId: "dddddddddddd", member: ref(LOCAL, "plain") },
      }),
    );
    expect(commandFor("mission leave")).not.toHaveBeenCalled();
  });

  it("releases only on the dashed box, not on the padding around it", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const drag = await dragBetween(
      rowOf(screen.container, "Update the release notes"),
      releaseZone(screen.container),
    );
    // Tailwind's padding is not loaded here, so the row gets its own.
    const row = releaseZone(screen.container)().closest("li")!;
    row.style.padding = "20px 0";
    const box = row.firstElementChild!.getBoundingClientRect();
    await drag.moveTo({ clientX: box.left + 20, clientY: box.top - 10 });
    await drag.release();
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
  });

  it("releases on the Threads list, not on the Missions heading or between missions", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const heading = screen.container.querySelector<HTMLElement>("h2")!;
    expect(heading.textContent).toContain("Missions");
    const [first, second] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-mission-drop]"),
    ].map((area) => area.getBoundingClientRect());
    const between = {
      clientX: first!.left + 40,
      clientY: (first!.bottom + second!.top) / 2,
    };
    for (const to of [heading, between]) {
      const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), to);
      await drag.release();
    }
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
    const threadsHeading = [...screen.container.querySelectorAll<HTMLElement>("h2")].find((h2) =>
      h2.textContent?.includes("Threads"),
    )!;
    for (const to of [threadsHeading, rowOf(screen.container, "Unrelated bug")]) {
      const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), to);
      await drag.release();
    }
    expect(commandFor("mission release member")).toHaveBeenCalledTimes(2);
  });

  it("releases nothing on blank space below the last row or in a gap under the Threads heading", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const headingRow = [...screen.container.querySelectorAll<HTMLElement>("h2")]
      .find((h2) => h2.textContent?.includes("Threads"))!
      .closest("li")!;
    // Room the stylesheet would leave: a gap under the heading, and space under the last row.
    headingRow.style.marginBottom = "24px";
    const list = headingRow.parentElement!;
    list.style.paddingBottom = "120px";
    const gap = () => ({
      clientX: headingRow.getBoundingClientRect().left + 40,
      clientY: headingRow.getBoundingClientRect().bottom + 12,
    });
    const blank = () => ({
      clientX: list.getBoundingClientRect().left + 40,
      clientY: list.getBoundingClientRect().bottom - 40,
    });
    for (const to of [gap, blank]) {
      const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), to);
      await drag.release();
    }
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
  });

  it("releases nothing on a project folder or on Show more", async () => {
    using _drag = allowDrag();
    // Enough settled threads, with the shelf open, for a Show more under them.
    localStorage.setItem("t3code:sidebar:settled-expanded", "true");
    onTestFinished(() => localStorage.removeItem("t3code:sidebar:settled-expanded"));
    const settled = Array.from({ length: 30 }, (_, index) =>
      shell(`old-${index}`, `Old thread ${index}`, { settled: true }),
    );
    for (const settings of [{ boringSidebarEnabled: true }, {}]) {
      await using screen = await renderSidebar(settings, { extra: settled });
      await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
      const target = settings.boringSidebarEnabled
        ? () => screen.container.querySelector<HTMLElement>('[data-sidebar-row^="folder:"]')!
        : () => screen.container.querySelector<HTMLElement>('[data-sidebar-row="settled:more"]')!;
      expect(target()).not.toBeNull();
      const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), target);
      await drag.release();
      // Each render starts its commands over, so each is checked here.
      expect(commandFor("mission release member")).not.toHaveBeenCalled();
    }
  });

  /** A 200px viewport over the list, as a short window has. */
  const shortViewport = (root: Element) => {
    const viewport = root.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    Object.assign(viewport.style, { height: "200px", overflow: "auto" });
    return viewport;
  };

  it("scrolls the grouped list while a member is held at its bottom edge, to the release zone", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar({ boringSidebarEnabled: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const viewport = shortViewport(screen.container);
    const view = viewport.getBoundingClientRect();
    const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), {
      clientX: view.left + 40,
      clientY: view.bottom - 2,
    });
    expect(releaseZone(screen.container)().getBoundingClientRect().top).toBeGreaterThan(
      view.bottom,
    );
    await vi.waitFor(
      () =>
        expect(releaseZone(screen.container)().getBoundingClientRect().bottom).toBeLessThan(
          view.bottom - 12,
        ),
      { timeout: 10_000 },
    );
    await drag.moveTo(releaseZone(screen.container)());
    await drag.release();
    expect(commandFor("mission release member")).toHaveBeenCalledExactlyOnceWith({
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "docs") },
    });
  });

  it("scrolls up to missions above the list while a thread is held at its top edge", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const viewport = shortViewport(screen.container);
    const areas = [...screen.container.querySelectorAll<HTMLElement>("[data-mission-drop]")];
    viewport.scrollTop =
      areas.at(-1)!.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + 20;
    const view = viewport.getBoundingClientRect();
    expect(areas.every((area) => area.getBoundingClientRect().bottom < view.top)).toBe(true);
    const drag = await dragBetween(rowOf(screen.container, "Unrelated bug"), {
      clientX: view.left + 40,
      clientY: view.top + 2,
    });
    await vi.waitFor(() => expect(areas.map(hintIn)).toContain("Add to mission"), {
      timeout: 10_000,
    });
    await drag.release();
    expect(commandFor("mission add member")).toHaveBeenCalledOnce();
  });

  it("adds and releases nothing where the scrolled list is hidden", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    // A short viewport scrolled down: the first mission runs up behind the header, and the
    // release zone sits below the footer.
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    Object.assign(viewport.style, { height: "200px", overflow: "auto" });
    const shipTop = shipArea(screen.container).getBoundingClientRect().top;
    viewport.scrollTop = shipTop - viewport.getBoundingClientRect().top + 40;
    const view = viewport.getBoundingClientRect();
    const ship = shipArea(screen.container).getBoundingClientRect();
    expect(ship.top).toBeLessThan(view.top);
    const behindHeader = { clientX: ship.left + 40, clientY: view.top - 5 };
    const add = await dragBetween(rowOf(screen.container, "Unrelated bug"), behindHeader);
    expect(hintIn(shipArea(screen.container))).toBeNull();
    await add.release();
    const release = await dragBetween(
      rowOf(screen.container, "Update the release notes"),
      releaseZone(screen.container),
    );
    expect(releaseZone(screen.container)().getBoundingClientRect().top).toBeGreaterThan(
      view.bottom,
    );
    await release.release();
    expect(commandFor("mission add member")).not.toHaveBeenCalled();
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
  });

  it("does not drag a mission's lead, into another mission or out of its own", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const other = screen.container.querySelector<HTMLElement>(
      '[data-mission-drop="local:ba9876543210"]',
    )!;
    const intoOther = await dragBetween(rowOf(screen.container, "Plan the v2 release"), other);
    expect(hintIn(other)).toBeNull();
    await intoOther.release();
    const out = await dragBetween(
      rowOf(screen.container, "Plan the v2 release"),
      rowOf(screen.container, "Unrelated bug"),
    );
    expect(screen.container.textContent).not.toContain("Leave mission");
    await out.release();
    expect(commandFor("mission add member")).not.toHaveBeenCalled();
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
  });
});

describe("new missions and missing leads", () => {
  it("shows no Missions heading and no New mission button before the first mission", async () => {
    const kept = listedMissions.splice(0);
    onTestFinished(() => {
      listedMissions.push(...kept);
    });
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    expect(screen.getByRole("heading").elements()).toHaveLength(0);
    expect(screen.container.querySelector('[aria-label="New mission"]')).toBeNull();
  });

  it("offers a gone lead's mission a new lead, or a thread with messages in no other mission", async () => {
    listedClaims.push({ threadId: ThreadId.make("guide"), missionId: "ffffffffffff", name: "X" });
    onTestFinished(() => {
      listedClaims.length = 0;
    });
    const show = vi.fn().mockResolvedValue("plain");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    await using screen = await renderSidebar(
      {},
      { extra: [shell("empty", "Empty thread", { empty: true })] },
    );
    await expect.element(screen.getByText("Lead deleted")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New lead" }));
    expect(openCommandPalette).toHaveBeenCalledWith({
      open: "new-thread-in",
      mission: {
        kind: "lead",
        host: LOCAL,
        missionId: "ba9876543210",
        name: "Old work",
        expectedLead: ThreadId.make("deleted-lead"),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Choose a thread…" }));
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const offered = (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map(
      (item) => item.id,
    );
    expect(offered).toContain("plain");
    expect(offered).not.toContain("empty");
    expect(offered).not.toContain("guide");
    await vi.waitFor(() =>
      expect(commandFor("mission set lead")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: {
          missionId: "ba9876543210",
          lead: ref(LOCAL, "plain"),
          expectedLead: ThreadId.make("deleted-lead"),
        },
      }),
    );
  });

  it("says a menu opened before another lead took over is too late, and offers no retry", async () => {
    const show = vi.fn().mockResolvedValue("plain");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Lead deleted")).toBeInTheDocument();
    commandFor("mission set lead").mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new MissionError({
          message: "This mission already has a new lead.",
          reason: "lead-changed",
        }),
      ),
    });
    await userEvent.click(screen.getByRole("button", { name: "Choose a thread…" }));
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: "This mission already has a new lead" }),
      ),
    );
    expect(toasts.mock.calls[0]![0]).not.toHaveProperty("actionProps");
  });
});
