import { createMemoryHistory } from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { draftSendState } from "~/components/chat/chatViewSend";
import { SCRATCH_REPLY_TIMEOUT_MS } from "~/components/chat/pendingScratchStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { DraftId, markPromotedDraftThreadByRef, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  clearMissionDraft,
  markMissionDraft,
  missionDraftOf,
} from "~/components/sidebar/missionDraftStore";
import { openCommandPalette } from "~/commandPaletteBus";
import type { MissionDraftIntent } from "~/components/sidebar/missions.logic";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

// A machine the project could be cloned to, for a test that offers one.
const addTargets = vi.hoisted(() => ({ offered: [] as ReadonlyArray<unknown> }));
vi.mock(import("~/hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: (() => addTargets.offered) as never,
}));

// The Missions this machine keeps, for a test that lists some.
const missionHosts = vi.hoisted(() => ({
  listed: [] as ReadonlyArray<unknown>,
  listeners: new Set<() => void>(),
}));
vi.mock(import("~/components/sidebar/MissionsSection"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    missionHosts.listeners.add(listener);
    return () => missionHosts.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useMissionHosts: (() => useSyncExternalStore(subscribe, () => missionHosts.listed)) as never,
  };
});

// A home for threads without a project, on the given machines, opened when the test says.
const scratch = vi.hoisted(() => ({
  homes: null as ReadonlyArray<string> | null,
  usual: "",
  open: null as
    | ((environmentId: string, failureTitle?: string, signal?: AbortSignal) => Promise<unknown>)
    | null,
}));
vi.mock(import("~/hooks/useScratchProject"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useScratchProject: () => {
      const real = actual.useScratchProject();
      const homes = scratch.homes;
      if (homes === null) return real;
      return {
        ...real,
        scratchEnvironmentId: () => scratch.usual as EnvironmentId,
        scratchWorkspaceRootFor: (environmentId) =>
          environmentId !== null && homes.includes(environmentId) ? "/scratch" : null,
        openScratchProject: scratch.open as never,
      };
    },
  };
});

// The browser preview's annotation send, as the right panel hands it out.
const annotation = vi.hoisted(() => ({
  send: null as ((annotation: unknown, image: null) => void) | null,
}));
vi.mock(import("~/components/chat/RightPanelSurfaceContent"), () => ({
  RightPanelSurfaceContent: ((props: { onSendAnnotation: typeof annotation.send }) => {
    annotation.send = props.onSendAnnotation;
    return null;
  }) as never,
}));

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const missionTrigger = () =>
  page.getByRole("button", {
    name: /^(Mission: .*|Add to a mission|New mission|New lead for .*)$/,
  });

it("the new-thread project picker follows the manual sidebar project order", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarProjectSortOrder: "manual",
  });
  useUiStateStore.setState({
    projectOrder: [
      `${ENVIRONMENT_ID}:/workspace/beta`,
      `${ENVIRONMENT_ID}:/workspace/render`,
      `${ENVIRONMENT_ID}:/workspace/alpha`,
    ],
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const draftId = DraftId.make("draft-manual-order");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // The shell snapshot has arrived once the sidebar lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await expect.element(page.getByRole("option", { name: "beta" })).toBeVisible();

  // The draft's own project leads; the rest keep the sidebar's order.
  await vi.waitFor(() => {
    expect(
      page
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/render$/),
      expect.stringMatching(/beta$/),
      expect.stringMatching(/alpha$/),
      "Add project",
    ]);
  });
});

it("a mission draft's project picker offers only its machine's projects", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: ProjectId.make("project-alpha"), title: "alpha" }],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-mission-machine");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  // The Mission it leads lives on a machine none of these projects are on.
  markMissionDraft(draftId, {
    intent: { kind: "new" },
    thread: { environmentId: EnvironmentId.make("mission-machine"), threadId: ThreadId.make("t") },
  });
  onTestFinished(() => clearMissionDraft(draftId));

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  expect(await projectOptions()).toEqual(["Add project"]);
});

/** The names the open Project picker offers. */
async function projectOptions() {
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await expect.element(page.getByRole("option", { name: "Add project" })).toBeVisible();
  return page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent);
}

const leadIntent = {
  kind: "lead",
  host: ENVIRONMENT_ID,
  missionId: "ba9876543210",
  name: "Old work",
  expectedLead: ThreadId.make("deleted-lead"),
} as const;

/** The app on an empty draft, with New thread in... picking the render project. */
async function openApp() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const start = DraftId.make("draft-start");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), start);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${start}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const openDraftId = () => DraftId.make(router.state.location.pathname.replace("/draft/", ""));
  const newThreadIn = async (mission?: MissionDraftIntent) => {
    const before = openDraftId();
    openCommandPalette({ open: "new-thread-in", ...(mission ? { mission } : {}) });
    await page
      .getByRole("option", { name: /render/ })
      .first()
      .click();
    await vi.waitFor(() => expect(openDraftId()).not.toBe(before));
    const opened = openDraftId();
    onTestFinished(() => clearMissionDraft(opened));
    return opened;
  };
  return Object.assign(app, { newThreadIn });
}

it("a plain new thread in a New-lead draft's project gets its own draft", async () => {
  using _environment = installFakeEnvironment([]);
  await using app = await openApp();
  const lead = await app.newThreadIn(leadIntent);
  expect(missionDraftOf(lead)?.intent).toEqual(leadIntent);
  const plain = await app.newThreadIn();
  expect(missionDraftOf(plain)).toBeUndefined();
  expect(missionDraftOf(lead)?.intent).toEqual(leadIntent);
  expect(useComposerDraftStore.getState().getDraftSession(lead)).not.toBeNull();
});

it("a new mission from a New-lead draft starts on a draft of its own", async () => {
  using _environment = installFakeEnvironment([]);
  await using app = await openApp();
  const lead = await app.newThreadIn(leadIntent);
  const started = await app.newThreadIn({ kind: "new" });
  expect(missionDraftOf(started)?.intent).toEqual({ kind: "new" });
  expect(missionDraftOf(lead)?.intent).toEqual(leadIntent);
  expect(useComposerDraftStore.getState().getDraftSession(lead)).not.toBeNull();
});

it("does not offer a mission draft another machine to run on", async () => {
  using _environment = installFakeEnvironment([]);
  addTargets.offered = [
    { environmentId: EnvironmentId.make("laptop"), label: "Laptop", machine: "desktop" },
  ];
  onTestFinished(() => {
    addTargets.offered = [];
  });
  const plainDraft = DraftId.make("draft-plain-run-on");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), plainDraft);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${plainDraft}`] }));
  await router.load();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const runOn = () => document.querySelectorAll<HTMLElement>('[aria-label="Run on"]');
  // A plain draft offers the other machine.
  await vi.waitFor(() => expect(runOn().length).toBeGreaterThan(0));
  await userEvent.click(page.elementLocator(runOn()[0]!));
  await expect.element(page.getByRole("option", { name: "Add to another machine" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  // Marked as a mission draft, it keeps to its machine.
  const threadId = useComposerDraftStore.getState().getDraftSession(plainDraft)!.threadId;
  await act(() =>
    markMissionDraft(plainDraft, {
      intent: { kind: "new" },
      thread: { environmentId: ENVIRONMENT_ID, threadId },
    }),
  );
  onTestFinished(() => clearMissionDraft(plainDraft));
  await vi.waitFor(() => expect(runOn()).toHaveLength(0));
  expect(document.body.textContent).not.toContain("Add to another machine");
});

it("a new thread's Mission choice marks its draft to join that mission, or none", async () => {
  using _environment = installFakeEnvironment([]);
  missionHosts.listed = [
    {
      environmentId: ENVIRONMENT_ID,
      snapshot: {
        missions: [
          {
            missionId: "ba9876543210",
            name: "Ship v2",
            createdAt: "2026-11-23T00:00:00.000Z",
            members: [
              {
                ref: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("lead") },
                role: "lead",
                state: "active",
              },
            ],
          },
        ],
        links: [],
        claims: [],
      },
    },
  ];
  onTestFinished(() => {
    missionHosts.listed = [];
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-mission-choice");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  onTestFinished(() => clearMissionDraft(draftId));
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const trigger = missionTrigger();
  await expect.element(page.getByRole("button", { name: "Add to a mission" })).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Project: render" })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("What should we build in render?");
  // The trigger moves between the footer and the heading, and keyboard focus moves with it.
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio", { name: "Ship v2" })).toBeVisible();
  await userEvent.keyboard("S");
  await expect.element(page.getByRole("menuitemradio", { name: "Ship v2" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(missionDraftOf(draftId)).toMatchObject({
    intent: { kind: "member", host: ENVIRONMENT_ID, missionId: "ba9876543210", name: "Ship v2" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  await expect.element(trigger).toMatchTextContent(/Ship v2$/);
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("What should we build in render, in mission Ship v2?");
  await expect.element(page.getByRole("button", { name: "Mission: Ship v2" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio", { name: "None" })).toBeVisible();
  await userEvent.keyboard("{Home}");
  await expect.element(page.getByRole("menuitemradio", { name: "None" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(missionDraftOf(draftId)).toBeUndefined();
  await expect.element(page.getByRole("button", { name: "Add to a mission" })).toHaveFocus();

  // A new mission it leads fixes the choice.
  await userEvent.click(trigger);
  await page.getByRole("menuitemradio", { name: "New mission (this thread leads)" }).click();
  expect(missionDraftOf(draftId)).toMatchObject({
    intent: { kind: "new" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  await expect.element(trigger).toMatchTextContent(/a new mission$/);
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("What should we build in render, in a new mission?");
  await expect.element(trigger).toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByText("Sending starts a new mission led by this thread"))
    .toBeVisible();
});

it("New thread in this mission opens a project's draft that joins the mission once sent", async () => {
  using _environment = installFakeEnvironment([]);
  missionHosts.listed = [
    {
      environmentId: ENVIRONMENT_ID,
      snapshot: {
        missions: [
          {
            missionId: "ba9876543210",
            name: "Ship v2",
            createdAt: "2026-11-23T00:00:00.000Z",
            members: [],
          },
        ],
        links: [],
        claims: [],
      },
    },
  ];
  onTestFinished(() => {
    missionHosts.listed = [];
  });
  await using app = await openApp();
  const member = {
    kind: "member",
    host: ENVIRONMENT_ID,
    missionId: "ba9876543210",
    name: "Ship v2",
  } as const;
  const joining = await app.newThreadIn(member);
  expect(missionDraftOf(joining)?.intent).toEqual(member);
  await expect.element(missionTrigger()).toMatchTextContent(/Ship v2$/);
  await expect.element(page.getByText('Sending adds this thread to "Ship v2"')).toBeVisible();
});

it.each([
  ["the mission a draft joins on another machine", true, "Ship v2"],
  ["a mission that machine no longer lists as unavailable", false, "Unavailable mission"],
] as const)("the Mission choice shows %s", async (_, listed, shown) => {
  using _environment = installFakeEnvironment([]);
  const laptop = EnvironmentId.make("laptop");
  missionHosts.listed = [
    {
      environmentId: laptop,
      snapshot: {
        missions: listed
          ? [
              {
                missionId: "ba9876543210",
                name: "Ship v2",
                createdAt: "2026-11-23T00:00:00.000Z",
                members: [],
              },
            ]
          : [],
        links: [],
        claims: [],
      },
    },
  ];
  onTestFinished(() => {
    missionHosts.listed = [];
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-joins-elsewhere");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  markMissionDraft(draftId, {
    intent: { kind: "member", host: laptop, missionId: "ba9876543210", name: "Ship v2" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(missionTrigger()).toMatchTextContent(new RegExp(`${shown}$`));
});

it("the Mission choice tells apart two machines' missions that share an id", async () => {
  using _environment = installFakeEnvironment([]);
  const laptop = EnvironmentId.make("laptop");
  const missionOn = (environmentId: EnvironmentId, name: string) => ({
    environmentId,
    snapshot: {
      missions: [
        { missionId: "ba9876543210", name, createdAt: "2026-11-23T00:00:00.000Z", members: [] },
      ],
      links: [],
      claims: [],
    },
  });
  missionHosts.listed = [missionOn(ENVIRONMENT_ID, "Local work"), missionOn(laptop, "Laptop work")];
  onTestFinished(() => {
    missionHosts.listed = [];
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-same-mission-id");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  // New thread in this mission marked it to join the laptop's mission.
  markMissionDraft(draftId, {
    intent: { kind: "member", host: laptop, missionId: "ba9876543210", name: "Laptop work" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const trigger = missionTrigger();
  await expect.element(trigger).toMatchTextContent(/Laptop work$/);
  await userEvent.click(trigger);
  await page.getByRole("menuitemradio", { name: "Local work" }).click();
  expect(missionDraftOf(draftId)?.intent).toEqual({
    kind: "member",
    host: ENVIRONMENT_ID,
    missionId: "ba9876543210",
    name: "Local work",
  });
  await expect.element(trigger).toMatchTextContent(/Local work$/);
});

const shipV2 = {
  missionId: "ba9876543210",
  name: "Ship v2",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [],
};
const hostWith = (
  environmentId: EnvironmentId,
  links: ReadonlyArray<{ environmentId: EnvironmentId; label: string; fullAccess: boolean }> = [],
) => ({ environmentId, snapshot: { missions: [shipV2], links, claims: [] } });
function listMissions(hosts: ReadonlyArray<unknown>) {
  missionHosts.listed = hosts;
  onTestFinished(() => {
    missionHosts.listed = [];
  });
}

/** The app on a draft of the render project, marked for a Mission when given one. */
async function openDraft(name: string, intent?: MissionDraftIntent, missionsOn = true) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarMissionsEnabled: missionsOn,
  });
  const draftId = DraftId.make(name);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  if (intent) {
    markMissionDraft(draftId, { intent, thread: { environmentId: ENVIRONMENT_ID, threadId } });
  }
  onTestFinished(() => clearMissionDraft(draftId));
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  return Object.assign(app, { draftId, router });
}

it.each([
  ["a machine that links to it with full access", true],
  ["a machine without full access", false],
] as const)(
  "a draft joining a mission offers projects only where it can join, not on %s",
  async (_, fullAccess) => {
    using _environment = installFakeEnvironment([]);
    const laptop = EnvironmentId.make("laptop");
    listMissions([
      hostWith(laptop, [{ environmentId: ENVIRONMENT_ID, label: "Desk", fullAccess }]),
    ]);
    await using _app = await openDraft("draft-join-machines", {
      kind: "member",
      host: laptop,
      missionId: shipV2.missionId,
      name: "Ship v2",
    });
    expect((await projectOptions()).some((name) => name?.endsWith("render"))).toBe(fullAccess);
  },
);

it.each([
  [
    "starts a new mission",
    { kind: "new" },
    "What should we build in render, in a new mission?",
    "New mission",
    "Sending starts a new mission led by this thread",
  ],
  [
    "leads a mission",
    leadIntent,
    "What should we build in render, as the new lead for Old work?",
    "New lead for Old work",
    'Sending makes this thread the lead of "Old work"',
  ],
] as const)(
  "a draft that %s shows its mission fixed, and says why",
  async (_, intent, heading, name, notice) => {
    using _environment = installFakeEnvironment([]);
    listMissions([hostWith(ENVIRONMENT_ID)]);
    await using _app = await openDraft("draft-fixed-mission", intent);
    const trigger = page.getByRole("button", { name });
    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    await expect.element(trigger).toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByText(notice)).toBeVisible();
    // The pointer lands on the tooltip's wrapper, as it does with the app's styles.
    await userEvent.hover(page.elementLocator(trigger.element().parentElement!));
    await expect
      .element(
        page.getByText(
          "This thread leads its mission, so it cannot join another. Send it as a plain thread to undo this.",
        ),
      )
      .toBeVisible();
    // The user picks the lead's project on the mission's machine.
    await userEvent.unhover(page.elementLocator(trigger.element().parentElement!));
    expect(await projectOptions()).toContainEqual(expect.stringMatching(/render$/));
  },
);

it("with Missions off, a new thread shows the Project picker and no Mission picker", async () => {
  using _environment = installFakeEnvironment([]);
  listMissions([hostWith(ENVIRONMENT_ID)]);
  await using _app = await openDraft("draft-missions-off", undefined, false);
  await expect.element(page.getByRole("combobox", { name: "Project: render" })).toBeVisible();
  expect(document.querySelector("[data-draft-mission-trigger]")).toBeNull();
});

it("keeps a chosen mission's control while the draft's project title loads", async () => {
  using _environment = installFakeEnvironment([]);
  listMissions([hostWith(ENVIRONMENT_ID)]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-title-loading");
  const projectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  markMissionDraft(draftId, {
    intent: { kind: "member", host: ENVIRONMENT_ID, missionId: shipV2.missionId, name: "Ship v2" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  await using _screen = await render(
    <DraftHeroHeadline draftId={draftId} activeProjectRef={projectRef} activeProjectTitle={null} />,
  );
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Choose a project to start");
  await expect
    .element(page.getByRole("button", { name: "Mission: Ship v2" }))
    .toHaveTextContent("Mission: Ship v2");
});

it("a Project pick retargets the draft as the headline link did", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  await using app = await openDraft("draft-project-pick");
  // An empty draft opens the picked project's own draft.
  await projectOptions();
  await page.getByRole("option", { name: "beta" }).click();
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).not.toBe(`/draft/${app.draftId}`),
  );
  const opened = DraftId.make(app.router.state.location.pathname.replace("/draft/", ""));
  expect(useComposerDraftStore.getState().getDraftSession(opened)?.projectId).toBe("project-beta");

  // A draft with words in it moves to the picked project and keeps them.
  useComposerDraftStore.getState().setPrompt(opened, "Plan the launch");
  await projectOptions();
  await page.getByRole("option", { name: "alpha" }).click();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getDraftSession(opened)?.projectId).toBe(
      "project-alpha",
    ),
  );
  expect(app.router.state.location.pathname).toBe(`/draft/${opened}`);
  expect(useComposerDraftStore.getState().getComposerDraft(opened)?.prompt).toBe("Plan the launch");
});

it("with Missions off, a draft joining a mission keeps the projects on its own machine", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await openDraft(
    "draft-missions-off-member",
    {
      kind: "member",
      host: EnvironmentId.make("laptop"),
      missionId: shipV2.missionId,
      name: "Ship v2",
    },
    false,
  );
  expect(await projectOptions()).toContainEqual(expect.stringMatching(/render$/));
});

it("a fixed Mission choice takes keyboard focus and says why, without opening a menu", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await openDraft("draft-fixed-keyboard", { kind: "new" });
  document.querySelector<HTMLElement>("[data-draft-project-trigger]")!.focus();
  await userEvent.tab();
  const trigger = page.getByRole("button", { name: "New mission" });
  await expect.element(trigger).toHaveFocus();
  await expect.element(trigger).toHaveAttribute("aria-disabled", "true");
  await expect
    .element(
      page.getByText(
        "This thread leads its mission, so it cannot join another. Send it as a plain thread to undo this.",
      ),
    )
    .toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(missionDraftOf(DraftId.make("draft-fixed-keyboard"))?.intent).toEqual({ kind: "new" });
});

const alphaProject = {
  environmentId: ENVIRONMENT_ID,
  id: ProjectId.make("project-alpha"),
  title: "alpha",
  workspaceRoot: "/workspace/alpha",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** No project opens on these machines; the returned function lets the open finish. */
function holdScratch(homes: ReadonlyArray<EnvironmentId>, usual: EnvironmentId = ENVIRONMENT_ID) {
  let finish = () => {};
  scratch.homes = homes;
  scratch.usual = usual;
  scratch.open = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(alphaProject);
      }),
  );
  onTestFinished(() => {
    scratch.homes = null;
    scratch.open = null;
  });
  return { opened: scratch.open, finish: () => act(() => finish()) };
}

async function pickNoProject() {
  await projectOptions();
  await page.getByRole("option", { name: "No project" }).click();
}

it("opens No project on an allowed machine when the usual one is not the mission's", async () => {
  const { opened } = holdScratch(
    [ENVIRONMENT_ID, "elsewhere" as EnvironmentId],
    "elsewhere" as EnvironmentId,
  );
  using _environment = installFakeEnvironment([]);
  await using _app = await openDraft("draft-scratch-fallback", { kind: "new" });
  await pickNoProject();
  expect(opened).toHaveBeenCalledWith(ENVIRONMENT_ID, undefined, expect.any(AbortSignal));
});

it.each([
  ["a draft with words in it", "Plan the launch"],
  ["an empty draft", ""],
] as const)(
  "No project left pending does not move %s that became a new mission",
  async (_, prompt) => {
    const { finish } = holdScratch([ENVIRONMENT_ID]);
    using _environment = installFakeEnvironment([], {
      extraProjects: [{ id: alphaProject.id, title: "alpha" }],
    });
    listMissions([hostWith(ENVIRONMENT_ID)]);
    await using app = await openDraft(`draft-scratch-then-mission-${prompt.length}`);
    if (prompt) await act(() => useComposerDraftStore.getState().setPrompt(app.draftId, prompt));
    await pickNoProject();
    const threadId = useComposerDraftStore.getState().getDraftSession(app.draftId)!.threadId;
    await act(() =>
      markMissionDraft(app.draftId, {
        intent: { kind: "new" },
        thread: scopeThreadRef(ENVIRONMENT_ID, threadId),
      }),
    );
    await finish();
    await act(async () => {});
    expect(app.router.state.location.pathname).toBe(`/draft/${app.draftId}`);
    expect(useComposerDraftStore.getState().getDraftSession(app.draftId)?.projectId).toBe(
      PROJECT_ID,
    );
    expect(missionDraftOf(app.draftId)?.intent).toEqual({ kind: "new" });
  },
);

it("No project left pending does not move a mission draft that started sending", async () => {
  const { finish } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  await using app = await openDraft("draft-scratch-then-send", { kind: "new" });
  const marked = missionDraftOf(app.draftId);
  await pickNoProject();
  // What a send does to the draft before the server answers.
  const session = useComposerDraftStore.getState().getDraftSession(app.draftId)!;
  await act(() => {
    markPromotedDraftThreadByRef(scopeThreadRef(session.environmentId, session.threadId));
    useComposerDraftStore.getState().setPrompt(app.draftId, "");
  });
  await finish();
  await act(async () => {});
  expect(app.router.state.location.pathname).toBe(`/draft/${app.draftId}`);
  expect(missionDraftOf(app.draftId)).toBe(marked);
});

it("while No project is preparing, the draft cannot send and its pickers are disabled", async () => {
  const { finish } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  listMissions([hostWith(ENVIRONMENT_ID)]);
  await using app = await openDraft("draft-scratch-preparing");
  await act(() => useComposerDraftStore.getState().setPrompt(app.draftId, "Plan the launch"));
  await pickNoProject();
  const project = page.getByRole("combobox", { name: "Project: No project…" });
  await expect.element(project).toHaveAttribute("data-disabled");
  await expect.element(project.getByRole("status", { name: "Loading" })).toBeVisible();
  await expect.element(missionTrigger()).toHaveAttribute("data-disabled");
  await expect.element(page.getByRole("button", { name: "Preparing No project…" })).toBeDisabled();
  await finish();
  await expect.element(project).not.toBeInTheDocument();
  await expect.element(missionTrigger()).not.toHaveAttribute("data-disabled");
  expect(document.body.textContent).not.toContain("Preparing No project…");
});

it("opening another thread before No project is ready leaves the user there", async () => {
  const { finish } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  await using app = await openDraft("draft-scratch-then-leave", { kind: "new" });
  const marked = missionDraftOf(app.draftId);
  await pickNoProject();
  const other = DraftId.make("draft-opened-instead");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, alphaProject.id), other);
  await act(() => app.router.navigate({ href: `/draft/${other}` }));
  await finish();
  await act(async () => {});
  expect(app.router.state.location.pathname).toBe(`/draft/${other}`);
  expect(missionDraftOf(app.draftId)).toBe(marked);
  expect(missionDraftOf(other)).toBeUndefined();
});

it("drops No project with a note when the mission's link loses full access first", async () => {
  const { finish } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  const laptop = EnvironmentId.make("laptop");
  const linked = (fullAccess: boolean) => [
    hostWith(laptop, [{ environmentId: ENVIRONMENT_ID, label: "Desk", fullAccess }]),
  ];
  listMissions(linked(true));
  await using app = await openDraft("draft-scratch-link-lost", {
    kind: "member",
    host: laptop,
    missionId: shipV2.missionId,
    name: "Ship v2",
  });
  await pickNoProject();
  await act(() => {
    missionHosts.listed = linked(false);
    for (const listener of missionHosts.listeners) listener();
  });
  await finish();
  await expect
    .element(page.getByText("This draft's mission no longer allows that machine."))
    .toBeVisible();
  expect(app.router.state.location.pathname).toBe(`/draft/${app.draftId}`);
  expect(useComposerDraftStore.getState().getDraftSession(app.draftId)?.projectId).toBe(PROJECT_ID);
});

it("a No project request that never answers unlocks the draft after the timeout", async () => {
  const { opened } = holdScratch([ENVIRONMENT_ID]);
  // Only the picker's 15 second wait is shortened.
  const setTimeoutBefore = window.setTimeout;
  vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) =>
    setTimeoutBefore(
      handler,
      ms === SCRATCH_REPLY_TIMEOUT_MS ? 1_500 : ms,
      ...args,
    )) as typeof window.setTimeout);
  onTestFinished(() => vi.mocked(window.setTimeout).mockRestore());
  using _environment = installFakeEnvironment([]);
  listMissions([hostWith(ENVIRONMENT_ID)]);
  await using app = await openDraft("draft-scratch-stalled");
  await act(() => useComposerDraftStore.getState().setPrompt(app.draftId, "Plan the launch"));
  await pickNoProject();
  await expect.element(page.getByRole("button", { name: "Preparing No project…" })).toBeDisabled();
  await expect.element(page.getByText("The machine did not answer in time.")).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Project: render" })).toBeEnabled();
  await expect.element(missionTrigger()).not.toHaveAttribute("data-disabled");
  await expect.element(page.getByRole("button", { name: "Submit message" })).toBeEnabled();
  // The request itself was aborted, which frees the machine's project queue.
  expect(vi.mocked(opened).mock.calls[0]?.[2]).toMatchObject({ aborted: true });
});

it("a browser annotation cannot send while No project is preparing", async () => {
  holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([]);
  await using app = await openDraft("draft-scratch-annotation");
  const session = useComposerDraftStore.getState().getDraftSession(app.draftId)!;
  const panelsBefore = useRightPanelStore.getState();
  onTestFinished(() => {
    useRightPanelStore.setState(panelsBefore, true);
  });
  await pickNoProject();
  await act(() =>
    useRightPanelStore
      .getState()
      .openBrowser(scopeThreadRef(session.environmentId, session.threadId), null),
  );
  await vi.waitFor(() => expect(annotation.send).not.toBeNull());
  await act(() =>
    annotation.send!(
      {
        id: "annotation",
        pageUrl: "http://localhost:3000/",
        pageTitle: null,
        comment: "Make this button blue",
        elements: [],
        regions: [],
        strokes: [],
        styleChanges: [],
        screenshot: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      null,
    ),
  );
  await expect.element(page.getByText("Preparing No project…", { exact: true })).toBeVisible();
  expect(useComposerDraftStore.getState().getDraftSession(app.draftId)?.promotedTo).toBeFalsy();
});

it("refuses No project while the draft's send is in flight", async () => {
  const { opened } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([]);
  await using app = await openDraft("draft-scratch-while-sending");
  const session = useComposerDraftStore.getState().getDraftSession(app.draftId)!;
  const sending = draftSendState(
    scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)),
  ).sendInFlight;
  sending.current = true;
  onTestFinished(() => {
    sending.current = false;
  });
  await pickNoProject();
  expect(opened).not.toHaveBeenCalled();
  await expect.element(page.getByRole("combobox", { name: "Project: render" })).toBeEnabled();
});

it("opening Settings before No project is ready keeps the user in Settings", async () => {
  const { opened, finish } = holdScratch([ENVIRONMENT_ID]);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  await using app = await openDraft("draft-scratch-then-settings");
  await pickNoProject();
  await act(() => app.router.navigate({ href: "/settings/general" }));
  await finish();
  await act(async () => {});
  expect(app.router.state.location.pathname).toBe("/settings/general");
  expect(useComposerDraftStore.getState().getDraftSession(app.draftId)?.projectId).toBe(PROJECT_ID);
  expect(vi.mocked(opened).mock.calls[0]?.[2]).toMatchObject({ aborted: true });
});

it("applies No project from a machine that is still allowed after the usual home changes", async () => {
  const secondary = EnvironmentId.make("secondary");
  const { opened, finish } = holdScratch([ENVIRONMENT_ID, secondary], secondary);
  using _environment = installFakeEnvironment([], {
    extraProjects: [{ id: alphaProject.id, title: "alpha" }],
  });
  await using app = await openDraft("draft-scratch-primary-back");
  await act(() => useComposerDraftStore.getState().setPrompt(app.draftId, "Plan the launch"));
  await pickNoProject();
  expect(opened).toHaveBeenCalledWith(secondary, undefined, expect.any(AbortSignal));
  // The primary reconnects, so it is the usual home again, and the picker renders with it.
  await act(() => {
    scratch.usual = ENVIRONMENT_ID;
    missionHosts.listed = [...missionHosts.listed];
    for (const listener of missionHosts.listeners) listener();
  });
  await expect.element(page.getByRole("combobox", { name: "Project: No project…" })).toBeVisible();
  await finish();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getDraftSession(app.draftId)?.projectId).toBe(
      alphaProject.id,
    ),
  );
  expect(document.body.textContent).not.toContain("no longer allows that machine");
});
