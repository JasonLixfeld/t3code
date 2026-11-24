import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
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
const missionHosts = vi.hoisted(() => ({ listed: [] as ReadonlyArray<unknown> }));
vi.mock(import("~/components/sidebar/MissionsSection"), async (original) => ({
  ...(await original()),
  useMissionHosts: (() => missionHosts.listed) as never,
}));

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

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
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  expect(trigger).toBeNull();
  expect(document.body.textContent).not.toContain("or start without a project");
});

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
  const trigger = page.getByRole("button", { name: "Mission" });
  await expect.element(trigger).toHaveTextContent("None");
  await userEvent.click(trigger);
  await page.getByRole("menuitemradio", { name: "Ship v2" }).click();
  expect(missionDraftOf(draftId)).toMatchObject({
    intent: { kind: "member", host: ENVIRONMENT_ID, missionId: "ba9876543210", name: "Ship v2" },
    thread: { environmentId: ENVIRONMENT_ID, threadId },
  });
  await expect.element(trigger).toHaveTextContent("Ship v2");
  await userEvent.click(trigger);
  await page.getByRole("menuitemradio", { name: "None" }).click();
  expect(missionDraftOf(draftId)).toBeUndefined();

  // A draft that starts a mission of its own offers no mission to join.
  await act(() =>
    markMissionDraft(draftId, {
      intent: { kind: "new" },
      thread: { environmentId: ENVIRONMENT_ID, threadId },
    }),
  );
  await expect.element(trigger).not.toBeInTheDocument();
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
  await expect.element(page.getByRole("button", { name: "Mission" })).toHaveTextContent("Ship v2");
  await expect.element(page.getByText('Sending adds this thread to "Ship v2"')).toBeVisible();
});

it("the Mission choice shows the mission a draft joins on another machine", async () => {
  using _environment = installFakeEnvironment([]);
  const laptop = EnvironmentId.make("laptop");
  missionHosts.listed = [
    {
      environmentId: laptop,
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
  await expect.element(page.getByRole("button", { name: "Mission" })).toHaveTextContent("Ship v2");
});
