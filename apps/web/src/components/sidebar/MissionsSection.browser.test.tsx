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

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { openCommandPalette } from "../../commandPaletteBus";
import { readLocalApi } from "../../localApi";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useLiveShellEnvironmentIds } from "../../state/shell";
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
import { clearMissionDraft, missionDraftOf, serverThreadMissionDraftId } from "./missionDraftStore";
import { MissionPromptDialog } from "./MissionsSection";
import { SidebarProvider } from "../ui/sidebar";
import type { MissionHost } from "@t3tools/client-runtime/missions";

const LOCAL = EnvironmentId.make("local");
const LAPTOP = EnvironmentId.make("env-laptop");
const CONNECTED = [LOCAL, LAPTOP];
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
const listedMissions: Array<Mission> = [ship, gone, archived];
const listedClaims: Array<MissionHost["snapshot"]["claims"][number]> = [];
const hosts: Array<MissionHost> = [
  { environmentId: LOCAL, snapshot: { missions: listedMissions, links: [], claims: listedClaims } },
];
const savedPrompts = new Map<string, string>();
const subscribed: Array<ReadonlyArray<[string, boolean]>> = [];
const hostChanges = new Set<() => void>();
const publishHosts = () =>
  act(() => {
    for (const update of hostChanges) update();
  });
const readOnly = new Set<EnvironmentId>();
const permissions = new Map<string, ReturnType<typeof Atom.make<boolean>>>();
const mayChange = (environmentId: EnvironmentId) => {
  const key = `${environmentId}:${readOnly.has(environmentId)}`;
  const atom = permissions.get(key) ?? Atom.make(!readOnly.has(environmentId));
  permissions.set(key, atom);
  return atom;
};
const commands = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const commandFor = (label: string) => {
  const existing = commands.get(label);
  if (existing !== undefined) return existing;
  const command = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.set(label, command);
  return command;
};
const working = (thread: ReturnType<typeof shell>) => ({
  ...thread,
  runtime: { ...thread.runtime!, status: "running" as const },
});
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
vi.mock("../../state/shell", { spy: true });
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
      missionsLiveAcross: (environmentIdsKey: string) =>
        Atom.make((get) => {
          const pairs = JSON.parse(environmentIdsKey) as ReadonlyArray<[string, boolean]>;
          subscribed.push(pairs);
          const asked = new Map(pairs);
          const read = () =>
            hosts.flatMap((host) => {
              const omitPrompts = asked.get(host.environmentId);
              if (omitPrompts === undefined) return [];
              if (!omitPrompts) return [host];
              const missions = host.snapshot.missions.map(
                ({ prompt: _prompt, ...mission }) => mission,
              );
              return [
                {
                  ...host,
                  snapshot: { ...host.snapshot, missions, promptsOmitted: true as const },
                },
              ];
            });
          const update = () => get.setSelf(read());
          hostChanges.add(update);
          get.addFinalizer(() => hostChanges.delete(update));
          return read();
        }),
      missionPrompt: ({ input }: { input: { missionId: string } }) =>
        Atom.make(AsyncResult.success({ prompt: savedPrompts.get(input.missionId) ?? "" })),
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
    unconfigured?: ReadonlyArray<EnvironmentId>;
    docsSnoozed?: boolean;
    scope?: Project;
    later?: ReadonlyArray<ReturnType<typeof shell>>;
    extra?: ReadonlyArray<ReturnType<typeof shell>>;
    without?: ReadonlyArray<string>;
    keepsMissions?: boolean;
    synced?: ReadonlyArray<EnvironmentId>;
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
    new Map(
      CONNECTED.filter((id) => !(options.unconfigured ?? []).includes(id)).map((environmentId) => [
        environmentId,
        {
          scratchWorkspaceRoot: null,
          environment: { capabilities: { missions: options.keepsMissions ?? true } },
        } as unknown as EnvironmentServerConfig,
      ]),
    ),
  );
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue(CONNECTED);
  vi.mocked(useLiveShellEnvironmentIds).mockReturnValue(new Set(options.synced ?? CONNECTED));
  vi.mocked(useEnvironmentsWithScope).mockImplementation(
    (environments) => new Set(environments.map(({ environmentId }) => environmentId)),
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
const jumpsOf = (root: Element, titles: ReadonlyArray<string>) =>
  titles.map((title) => {
    const row =
      title === "draft"
        ? root.querySelector("[data-testid=sidebar-draft-row]")
        : rowOf(root, title);
    return [title, row?.textContent?.match(/Ctrl\+\d/)?.[0] ?? null];
  });

describe("missions in the sidebar", () => {
  it("heads each mission with its lead's row and lists unsettled members under it only, and a refused add as its refusal only", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Update the release notes");
    expect(members.textContent).toContain("Write the migration guide");
    expect(screen.getByText("Add pending (machine offline)").elements()).toHaveLength(2);
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
    const previous = useComposerDraftStore.getState();
    onTestFinished(() => {
      useComposerDraftStore.setState(previous, true);
    });
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

  it("marks a lead, read in or not, with the mission icon and a bold title, and spaces missions apart", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const loaded = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    const unloaded = screen
      .getByRole("button", { name: "Collapse mission Archive the old site, 0 threads" })
      .element()
      .closest("li")!;
    for (const [lead, title] of [
      [loaded, "Plan the v2 release"],
      [unloaded, "Archive the old site"],
    ] as const) {
      expect(lead.querySelector("[data-testid=mission-lead-icon]")).not.toBeNull();
      const text = [...lead.querySelectorAll("span")].find((span) => span.textContent === title)!;
      expect(getComputedStyle(text).fontWeight).toBe("600");
    }
    const docs = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:docs"]')!;
    expect(docs.querySelector("[data-testid=mission-lead-icon]")).toBeNull();
    const groups = [...screen.container.querySelectorAll<HTMLElement>("[data-mission-drop]")];
    expect(groups.length).toBeGreaterThan(1);
    for (const [above, below] of groups.slice(1).map((group, index) => [groups[index]!, group])) {
      const space = below!.getBoundingClientRect().top - above!.getBoundingClientRect().bottom;
      expect(space).toBeCloseTo(12, 0);
    }
  });

  it("keeps a working lead's status on hover when its machine offers no row actions", async () => {
    listedMissions.push({
      missionId: "eeeeeeeeeeee",
      name: "Laptop work",
      createdAt: "2026-11-23T00:00:00.000Z",
      members: [{ ref: ref(LAPTOP, "far-lead"), role: "lead", state: "active" }],
    });
    onTestFinished(() => {
      listedMissions.pop();
    });
    const farLead = working({ ...shell("far-lead", "Far lead"), environmentId: LAPTOP });
    await using screen = await renderSidebar({}, { extra: [farLead], unconfigured: [LAPTOP] });
    await expect.element(screen.getByText("Far lead", { exact: true })).toBeInTheDocument();
    const lead = () =>
      screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${LAPTOP}:far-lead"]`)!;
    const label = () =>
      [...lead().querySelectorAll<HTMLElement>("span")].find((span) =>
        [...span.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent === "Working",
        ),
      )!;
    const shown = (element: HTMLElement) => {
      for (let node = element; node !== lead(); node = node.parentElement!) {
        if (getComputedStyle(node).opacity === "0") return false;
      }
      return true;
    };
    await userEvent.hover(lead());
    expect(lead().matches(":hover")).toBe(true);
    expect(lead().dataset.testid).toBe("sidebar-row-card");
    expect(lead().querySelector('[aria-label^="Collapse mission"]')).not.toBeNull();
    expect(lead().querySelector('[aria-label="Settle thread"]')).toBeNull();
    expect(shown(label())).toBe(true);
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

  it("leaves from a row's menu only the mission the row is under, after its confirmation", async () => {
    claimDocs("ffffffffffff");
    const elsewhere = await memberMenu(null);
    expect(elsewhere.ids).toContain("mission-release:local:0123456789ab");
    expect(elsewhere.ids.filter((id) => id.startsWith("mission-leave:"))).toEqual([]);
    listedClaims.length = 0;
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
    const lead = await menuOf(rowOf(screen.container, "Plan the v2 release"), null);
    expect(lead).toContain("Pin thread");
    const group = lead.indexOf("Mission");
    expect(lead.slice(group, group + 4)).toEqual([
      "Mission",
      "New thread in this mission",
      "Edit mission prompt…",
      "End mission",
    ]);
    for (const absent of ["Start mission from this thread", "Add to mission", "Leave mission"]) {
      expect(lead).not.toContain(absent);
    }
    const member = await menuOf(rowOf(screen.container, "Update the release notes"), null);
    expect(member).toEqual(expect.arrayContaining(["Leave mission", "Add to mission"]));
    expect(member).not.toContain("New thread in this mission");
    const gone = screen.getByText("Lead deleted").element().closest("li")!;
    expect(await menuOf(gone, "mission-new-thread:local:ba9876543210")).toEqual([
      "Mission",
      "New thread in this mission",
      "Edit mission prompt…",
      "New lead",
      "Choose a thread…",
      "End mission",
    ]);
    await vi.waitFor(() =>
      expect(openCommandPalette).toHaveBeenCalledWith({
        open: "new-thread-in",
        mission: { kind: "member", host: LOCAL, missionId: "ba9876543210", name: "Old work" },
      }),
    );
    const loading = screen.getByText("Archive the old site").element().closest("li")!;
    await menuOf(loading, "mission-delete:local:cccccccccccc");
    expect(
      (show.mock.lastCall![0] as ReadonlyArray<{ readonly id: string }>).map((item) => item.id),
    ).toContain("mission-delete:local:cccccccccccc");
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
    savedPrompts.set("0123456789ab", "Ship it.");
    onTestFinished(() => savedPrompts.clear());
    await using screen = await renderSidebar();
    expect(subscribed.at(-1)).toContainEqual([LOCAL, true]);
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

  it("heads a mission with the lead's title beside a chevron named for the mission and its size, and every card's project below its title", async () => {
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
    const lead = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:lead"]')!;
    expect(lead.getAttribute("aria-label")).toBe("Plan the v2 release, web");
    expect(
      screen.container.querySelector('[data-sidebar-row="local:docs"]')!.getAttribute("aria-label"),
    ).toBe("Update the release notes, web");
    expect(
      screen.getByRole("button", {
        name: "Collapse mission Plan the v2 release, 5 threads",
        exact: true,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse mission Archive the old site, 0 threads" }),
    ).toBeInTheDocument();
    const chevron = lead.querySelector<HTMLElement>('[aria-label^="Collapse mission"]')!;
    const icon = chevron.nextElementSibling!;
    expect(icon.getAttribute("data-testid")).toBe("mission-lead-icon");
    expect(icon.nextElementSibling!.textContent).toBe("Plan the v2 release");
    for (const title of ["Plan the v2 release", "Update the release notes", "Unrelated bug"]) {
      const card = rowOf(screen.container, title);
      const titleBox = screen.getByText(title, { exact: true }).element().getBoundingClientRect();
      const project = card.querySelector("[data-testid=sidebar-row-project]")!;
      expect(project.textContent).toBe("web");
      expect(project.getBoundingClientRect().top).toBeGreaterThanOrEqual(titleBox.bottom);
    }
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(rowOf(members, "Write the migration guide").textContent).toContain(
      "Add pending (machine offline)",
    );
    expect(rowOf(members, "Update the release notes").textContent).toContain("web");
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

  it("lists a server's missions from before the capability, and edits the prompt its list sends", async () => {
    const show = vi.fn().mockResolvedValue("mission-prompt:local:0123456789ab");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    listedMissions[0] = { ...ship, prompt: "Ship it." };
    onTestFinished(() => {
      listedMissions[0] = ship;
    });
    await using screen = await renderSidebar({}, { keepsMissions: false });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    expect(screen.container.querySelector("[data-testid=sidebar-mission-members]")).not.toBeNull();
    expect(subscribed.at(-1)).toContainEqual([LOCAL, false]);
    await userEvent.click(rowOf(screen.container, "Plan the v2 release"), { button: "right" });
    const prompt = page.getByRole("textbox", { name: "Mission prompt" });
    await expect.element(prompt).toHaveValue("Ship it.");
    (page.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click();
    await expect.element(prompt).not.toBeInTheDocument();
  });

  const openPrompt = async (root: HTMLElement) => {
    const show = vi.fn().mockResolvedValue("mission-prompt:local:0123456789ab");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    await userEvent.click(rowOf(root, "Plan the v2 release"), { button: "right" });
    const prompt = page.getByRole("textbox", { name: "Mission prompt" });
    const save = () => page.getByRole("button", { name: "Save" }).element() as HTMLButtonElement;
    return {
      prompt,
      save,
      close: async () => {
        (page.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click();
        await expect.element(prompt).not.toBeInTheDocument();
      },
    };
  };

  it.each([
    ["one that reads it on its own", true, () => savedPrompts.set("0123456789ab", "Ship it.")],
    [
      "one that lists it",
      false,
      () => {
        listedMissions[0] = { ...ship, prompt: "Ship it." };
      },
    ],
  ] as const)(
    "saves nothing unchanged or changed only in spaces, then saves trimmed, and clears only an emptied prompt, on a server %s",
    async (_, keepsMissions, seed) => {
      seed();
      onTestFinished(() => {
        savedPrompts.clear();
        listedMissions[0] = ship;
      });
      await using screen = await renderSidebar({}, { keepsMissions });
      const editor = await openPrompt(screen.container);
      await expect.element(editor.prompt).toHaveValue("Ship it.");
      expect(editor.save().disabled).toBe(true);
      editor.save().click();
      await userEvent.fill(editor.prompt, "  Ship it.   ");
      expect(editor.save().disabled).toBe(true);
      editor.save().click();
      expect(commandFor("mission set prompt")).not.toHaveBeenCalled();
      await userEvent.fill(editor.prompt, "  Review it. ");
      editor.save().click();
      await vi.waitFor(() =>
        expect(commandFor("mission set prompt")).toHaveBeenCalledExactlyOnceWith({
          environmentId: LOCAL,
          input: { missionId: "0123456789ab", prompt: "Review it." },
        }),
      );
      await expect.element(editor.prompt).not.toBeInTheDocument();
      const again = await openPrompt(screen.container);
      await expect.element(again.prompt).toHaveValue("Ship it.");
      await userEvent.clear(again.prompt);
      again.save().click();
      await vi.waitFor(() =>
        expect(commandFor("mission set prompt")).toHaveBeenLastCalledWith({
          environmentId: LOCAL,
          input: { missionId: "0123456789ab", prompt: "" },
        }),
      );
    },
  );

  it("shows a prompt another client saved while the editor is untouched, and keeps what the user typed", async () => {
    await using screen = await renderSidebar({}, { keepsMissions: false });
    const editor = await openPrompt(screen.container);
    await expect.element(editor.prompt).toHaveValue("");
    listedMissions[0] = { ...ship, prompt: "Saved elsewhere." };
    onTestFinished(() => {
      listedMissions[0] = ship;
    });
    await publishHosts();
    await expect.element(editor.prompt).toHaveValue("Saved elsewhere.");
    expect(editor.save().disabled).toBe(true);
    editor.save().click();
    expect(commandFor("mission set prompt")).not.toHaveBeenCalled();
    await userEvent.fill(editor.prompt, "Mine.");
    listedMissions[0] = { ...ship, prompt: "Saved again elsewhere." };
    await publishHosts();
    await expect.element(editor.prompt).toHaveValue("Mine.");
    expect(editor.save().disabled).toBe(false);
    await editor.close();
  });

  it("shows each heading only while its setting is on, and none before the first mission", async () => {
    for (const settings of [
      { sidebarMissionsHeaderVisible: false },
      { sidebarMissionsHeaderVisible: false, sidebarThreadsHeaderVisible: false },
    ]) {
      await using screen = await renderSidebar(settings);
      await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Missions" }).elements()).toHaveLength(0);
      expect(screen.getByRole("heading", { name: "Threads" }).elements()).toHaveLength(
        settings.sidebarThreadsHeaderVisible === false ? 0 : 1,
      );
    }
    const kept = listedMissions.splice(0);
    onTestFinished(() => {
      listedMissions.push(...kept);
    });
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    expect(screen.getByRole("heading").elements()).toHaveLength(0);
  });
});

function allowDrag(): Disposable {
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
  vi.mocked(useEnvironmentScope).mockImplementation(
    (environmentId) => environmentId === null || !readOnly.has(environmentId),
  );
  return {
    [Symbol.dispose]: () => {
      vi.mocked(useConnectedEnvironmentIds).mockReset();
      vi.mocked(useEnvironmentScope).mockReset();
    },
  };
}

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
  let at = to;
  return {
    moveTo: (next: DragTarget) => {
      at = next;
      return act(() => pointer("pointermove", document, center(next)));
    },
    release: async () => {
      await act(() => pointer("pointerup", document, { ...center(at), buttons: 0 }));
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
  it("adds a dragged thread, even one with no messages, to the mission it is dropped on", async () => {
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

  it("reads in selected threads an unread older page holds, waiting for a read that answers late, and names those it cannot", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    const older = shell("older", "Old settled bug", { settled: true });
    const readIn = new Set<string>();
    const listedShell = vi.mocked(readThreadShell).getMockImplementation()!;
    vi.mocked(readThreadShell).mockImplementation((target) =>
      readIn.has(target.threadId) ? older : listedShell(target),
    );
    const family = Atom.make<AsyncResult.AsyncResult<{ threads: [] }, never>>(
      AsyncResult.initial(true),
    );
    using _family = vi.spyOn(threadFamilies, "familyAtom").mockReturnValue(family as never);
    using mount = vi.spyOn(threadFamilies, "mount").mockImplementation(() => () => {});
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:plain", "local:older", "local:lost"]),
    });
    onTestFinished(() => useThreadSelectionStore.setState({ selectedThreadKeys: new Set() }));
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      rowOf(screen.container, "Plan the v2 release"),
    );
    await drag.release();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(commandFor("mission add member")).not.toHaveBeenCalled();
    readIn.add("older");
    await act(() => appAtomRegistry.set(family, AsyncResult.success({ threads: [] })));
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

  it.each(leaveRoutes("unread").filter(([machines]) => machines !== "only the lead's machine"))(
    "leaves at once from the X of a row its machine is still syncing when %s may be changed",
    async (_, writable, label, command) => {
      leadOnLaptop("active", writable, "unread");
      const confirm = vi.fn().mockResolvedValue(true);
      vi.mocked(readLocalApi).mockReturnValue({ dialogs: { confirm } } as unknown as LocalApi);
      await using screen = await renderSidebar({}, { synced: [LAPTOP] });
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

  it("shows no blank row for a member whose thread the list leaves out once its machine syncs", async () => {
    leadOnLaptop("active", [LOCAL, LAPTOP], "unread");
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Laptop launch").first()).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain(`Thread on ${LOCAL}`);
    expect(screen.container.querySelector('button[aria-label="Leave mission"]')).toBeNull();
  });

  it.each(leaveRoutes("plain").filter(([machines]) => machines !== "only the member's machine"))(
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

  it("retries a refused leave by the route that works for each mission, and dismisses one", async () => {
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
    leadOnLaptop("release-refused", [LOCAL], "unread");
    await using screen = await renderSidebar();
    const refusal = screen.getByText("Leave refused: The laptop refused it.");
    await expect.element(refusal).toBeInTheDocument();
    await expect.element(screen.getByText("Laptop launch").first()).toBeInTheDocument();
    const members = screen.container.querySelector("[data-testid=sidebar-mission-members]")!;
    expect(members.textContent).toContain("Unrelated bug");
    const button = (name: string) =>
      refusal.element().parentElement!.querySelector<HTMLElement>(`button[aria-label="${name}"]`)!;
    const laptopRetry = [
      ...screen.container.querySelectorAll<HTMLElement>('button[aria-label="Retry"]'),
    ].find((retry) => retry !== button("Retry"))!;
    expect(laptopRetry.hasAttribute("disabled")).toBe(false);
    laptopRetry.click();
    await vi.waitFor(() =>
      expect(commandFor("mission leave")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { threadId: "unread", missionId: "dddddddddddd" },
      }),
    );
    expect(commandFor("mission release member")).not.toHaveBeenCalled();
    const command = {
      environmentId: LOCAL,
      input: { missionId: "0123456789ab", member: ref(LOCAL, "plain") },
    };
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

  it("leaves nothing when a live update moves the dragged member to another mission", async () => {
    leadOnLaptop("active", [LOCAL, LAPTOP]);
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    const drag = await dragBetween(
      rowOf(screen.container, "Unrelated bug"),
      releaseZone(screen.container),
    );
    const laptop = hosts[1]!;
    hosts[1] = {
      ...laptop,
      snapshot: {
        ...laptop.snapshot,
        missions: laptop.snapshot.missions.map((mission) => ({
          ...mission,
          members: mission.members.filter((member) => member.ref.threadId !== "plain"),
        })),
      },
    };
    listedMissions.push({
      missionId: "eeeeeeeeeeee",
      name: "Moved here",
      createdAt: "2026-11-23T00:00:00.000Z",
      members: [
        { ref: ref(LOCAL, "moved-lead"), role: "lead", state: "active" },
        { ref: ref(LOCAL, "plain"), role: "member", state: "active" },
      ],
    });
    onTestFinished(() => void listedMissions.pop());
    listedClaims[0] = {
      threadId: ThreadId.make("plain"),
      missionId: "eeeeeeeeeeee",
      name: "Moved here",
    };
    const here = hosts[0]!;
    hosts[0] = { ...here, snapshot: { ...here.snapshot, missions: [...listedMissions] } };
    onTestFinished(() => {
      hosts[0] = here;
    });
    await publishHosts();
    await drag.moveTo(releaseZone(screen.container));
    await drag.release();
    await act(async () => {});
    expect(commandFor("mission leave")).not.toHaveBeenCalled();
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

  it("releases nothing on a project folder, Show more, blank space below the last row or a gap under the Threads heading", async () => {
    using _drag = allowDrag();
    localStorage.setItem("t3code:sidebar:settled-expanded", "true");
    onTestFinished(() => localStorage.removeItem("t3code:sidebar:settled-expanded"));
    const settled = Array.from({ length: 30 }, (_, index) =>
      shell(`old-${index}`, `Old thread ${index}`, { settled: true }),
    );
    for (const settings of [{ boringSidebarEnabled: true }, {}]) {
      await using screen = await renderSidebar(settings, { extra: settled });
      await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
      const row = settings.boringSidebarEnabled
        ? () => screen.container.querySelector<HTMLElement>('[data-sidebar-row^="folder:"]')!
        : () => screen.container.querySelector<HTMLElement>('[data-sidebar-row="settled:more"]')!;
      expect(row()).not.toBeNull();
      const targets: DragTarget[] = [row];
      if (!settings.boringSidebarEnabled) {
        const headingRow = [...screen.container.querySelectorAll<HTMLElement>("h2")]
          .find((h2) => h2.textContent?.includes("Threads"))!
          .closest("li")!;
        headingRow.style.marginBottom = "24px";
        const list = headingRow.parentElement!;
        list.style.paddingBottom = "120px";
        targets.push(
          () => ({
            clientX: headingRow.getBoundingClientRect().left + 40,
            clientY: headingRow.getBoundingClientRect().bottom + 12,
          }),
          () => ({
            clientX: list.getBoundingClientRect().left + 40,
            clientY: list.getBoundingClientRect().bottom - 40,
          }),
        );
      }
      for (const target of targets) {
        const drag = await dragBetween(rowOf(screen.container, "Update the release notes"), target);
        await drag.release();
      }
      expect(commandFor("mission release member")).not.toHaveBeenCalled();
    }
  });

  const shortViewport = (root: Element, height = "200px") => {
    const viewport = root.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    Object.assign(viewport.style, { height, overflow: "auto" });
    return viewport;
  };

  it("scrolls the grouped list while a member is held at its bottom edge, to the release zone", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar({ boringSidebarEnabled: true });
    await expect.element(screen.getByText("Update the release notes")).toBeInTheDocument();
    // Edge scrolling moves by the time between frames, so one late frame on a busy runner jumps
    // the whole list. Fake timers move it only as far as each vi.waitFor check advances the clock.
    using _timers = fakeTimers();
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
    await using screen = await renderSidebar({ sidebarMissionsHeaderVisible: false });
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    using _timers = fakeTimers();
    const viewport = shortViewport(screen.container, "120px");
    const areas = [...screen.container.querySelectorAll<HTMLElement>("[data-mission-drop]")];
    viewport.scrollTop =
      areas.at(-1)!.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + 20;
    const view = viewport.getBoundingClientRect();
    expect(areas.every((area) => area.getBoundingClientRect().bottom < view.top)).toBe(true);
    const drag = await dragBetween(rowOf(screen.container, "Unrelated bug"), {
      clientX: view.left + 40,
      clientY: view.top + 2,
    });
    await vi.waitFor(() => expect(hintIn(areas[0]!)).toBe("Add to mission"), { timeout: 10_000 });
    await drag.release();
    expect(commandFor("mission add member")).toHaveBeenCalledOnce();
  });

  it("adds and releases nothing where the scrolled list is hidden", async () => {
    using _drag = allowDrag();
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Unrelated bug")).toBeInTheDocument();
    using _timers = fakeTimers();
    const viewport = shortViewport(screen.container);
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
  it("offers a gone lead's mission a new lead or a thread with messages in no other mission, and says a pick made after another lead took over is too late, with no retry", async () => {
    listedClaims.push({ threadId: ThreadId.make("guide"), missionId: "ffffffffffff", name: "X" });
    onTestFinished(() => {
      listedClaims.length = 0;
    });
    const show = vi.fn().mockResolvedValue("plain");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
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
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: "This mission already has a new lead" }),
      ),
    );
    expect(toasts.mock.calls[0]![0]).not.toHaveProperty("actionProps");
  });

  it("marks an empty thread from its menu to lead a new mission when it first sends, drops the mark once it joins another mission, not when the add fails, and starts one at once from a thread with messages", async () => {
    const addShip = `mission-add:local:${ship.missionId}`;
    const show = vi
      .fn()
      .mockResolvedValueOnce("mission-start")
      .mockResolvedValueOnce(addShip)
      .mockResolvedValueOnce(addShip)
      .mockResolvedValueOnce("mission-start");
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    const empty = ref(LOCAL, "empty");
    onTestFinished(() => clearMissionDraft(serverThreadMissionDraftId(empty)));
    const toasts = vi.spyOn(toastManager, "add");
    onTestFinished(() => toasts.mockRestore());
    await using screen = await renderSidebar(
      {},
      { extra: [shell("empty", "Empty thread", { empty: true })] },
    );
    await expect.element(screen.getByText("Empty thread")).toBeInTheDocument();
    await userEvent.click(rowOf(screen.container, "Empty thread"), { button: "right" });
    await vi.waitFor(() =>
      expect(missionDraftOf(serverThreadMissionDraftId(empty))).toMatchObject({
        intent: { kind: "new" },
        thread: empty,
        step: "waiting",
      }),
    );
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/empty"));
    expect(commandFor("mission create")).not.toHaveBeenCalled();

    const addMember = commandFor("mission add member");
    addMember.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new MissionError({ message: "Laptop refused." })),
    });
    await userEvent.click(rowOf(screen.container, "Empty thread"), { button: "right" });
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenCalledWith(
        expect.objectContaining({ title: "0 added, 1 refused: Laptop refused." }),
      ),
    );
    expect(missionDraftOf(serverThreadMissionDraftId(empty))).toBeDefined();
    await userEvent.click(rowOf(screen.container, "Empty thread"), { button: "right" });
    await vi.waitFor(() =>
      expect(missionDraftOf(serverThreadMissionDraftId(empty))).toBeUndefined(),
    );
    expect(addMember).toHaveBeenLastCalledWith({
      environmentId: LOCAL,
      input: { missionId: ship.missionId, member: empty },
    });

    await userEvent.click(rowOf(screen.container, "Unrelated bug"), { button: "right" });
    await vi.waitFor(() =>
      expect(commandFor("mission create")).toHaveBeenCalledExactlyOnceWith({
        environmentId: LOCAL,
        input: { missionId: expect.any(String), leadThreadId: "plain" },
      }),
    );
    expect(missionDraftOf(serverThreadMissionDraftId(ref(LOCAL, "plain")))).toBeUndefined();
  });
});
