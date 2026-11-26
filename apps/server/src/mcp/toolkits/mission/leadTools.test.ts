import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MissionError,
  NodeId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { MemberWorkspaces } from "../../../missions/MemberWorkspaces.ts";
import * as ServerConfig from "../../../config.ts";
import * as MissionClaims from "../../../missions/MissionClaims.ts";
import * as Missions from "../../../missions/Missions.ts";
import type { RosterMember } from "../../../missions/missionStatus.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  idleThreadProjection,
  liveThreadShell,
  liveThreadsLayer,
} from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import * as ProjectHandlers from "../project/handlers.ts";
import { ProjectToolkit } from "../project/tools.ts";
import * as ThreadHandlers from "../thread/handlers.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import * as MissionHandlers from "./handlers.ts";
import { MissionToolkit } from "./tools.ts";

const noWorkspace = Layer.mock(MemberWorkspaces)({
  cached: () =>
    Effect.succeed({
      kind: "project" as const,
      repositories: [],
      truncated: false,
      otherPullRequests: [],
      stale: false,
    }),
  forget: () => Effect.void,
});

const HERE = EnvironmentId.make("env-here");
const LAPTOP = EnvironmentId.make("env-laptop");
const FENCED = EnvironmentId.make("env-fenced");
const MISSION = "0123456789ab";

const threadScope = (threadId: string) =>
  ({
    environmentId: HERE,
    requestNamespace: `provider:${threadId}`,
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: `provider:${threadId}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }) satisfies McpInvocationContext.McpInvocationScope;
const lead = threadScope("lead");
const notLead = threadScope("member");
const inMission = threadScope("in-mission");
const stamped = threadScope("stamped");

const row = (index: number, status: RosterMember["status"]): RosterMember => ({
  ref: { environmentId: LAPTOP, threadId: ThreadId.make(`t${index}`) },
  member: `member ${index + 1}`,
  place: "machine 2",
  machine: "Laptop",
  project: "web",
  status,
  title: `Title ${index}`,
});

const makeMissions = () => {
  const calls: Array<{
    readonly kind: string;
    readonly missionId: string;
    readonly member: ScopedThreadRef;
    readonly asLead: ThreadId | undefined;
  }> = [];
  const started = new Set<string>();
  const heard: Array<readonly [ThreadId, ScopedThreadRef, string]> = [];
  const add = (
    input: { readonly missionId: string; readonly member: ScopedThreadRef },
    asLead: ThreadId | undefined,
  ) =>
    Effect.suspend(() => {
      calls.push({ kind: "add", ...input, asLead });
      if (input.member.environmentId === FENCED) {
        return Effect.fail(
          new MissionError({
            message:
              "The link to Fenced box has auto access. A link below full access may change only threads it started, so relink Fenced box with full access to use its threads in a mission.",
          }),
        );
      }
      if (input.member.threadId === "taken") {
        return Effect.fail(
          new MissionError({ message: 'This thread is already in the mission "Other".' }),
        );
      }
      return Effect.succeed(
        input.member.environmentId === LAPTOP ? ("pending" as const) : ("joined" as const),
      );
    });
  const layer = Layer.mock(Missions.Missions)({
    heardInWait: (lead, member, runId) =>
      runId === "broken"
        ? Effect.die("The mission store is unreadable.")
        : Effect.sync(() => void heard.push([lead, member, runId])).pipe(
            Effect.andThen(Effect.forkChild(Effect.void)),
          ),
    joinStarted: (input, asLead) =>
      Effect.suspend(() => {
        const key = `${input.member.environmentId}/${input.member.threadId}`;
        if (started.has(key)) return Effect.undefined;
        started.add(key);
        return add(input, asLead);
      }),
    ledBy: (threadId) =>
      Effect.succeed(
        threadId === lead.thread.threadId
          ? { missionId: MISSION, name: "Ship", leadThreadId: threadId, createdAt: "", prompt: "" }
          : undefined,
      ),
    locallyLedMissionOf: (threadId) =>
      Effect.succeed(
        [lead, inMission, stamped].some((scope) => scope.thread.threadId === threadId)
          ? {
              missionId: MISSION,
              name: "Ship",
              leadThreadId: lead.thread.threadId,
              createdAt: "",
              prompt: "",
            }
          : undefined,
      ),
    memberStatuses: () => Effect.succeed([]),
    roster: () =>
      Effect.succeed(
        Array.from({ length: 12 }, (_, index) =>
          row(index, index === 0 ? "pending-approval" : "idle"),
        ),
      ),
    addAsLead: (asLead, member) =>
      asLead === lead.thread.threadId
        ? Effect.map(add({ missionId: MISSION, member }, asLead), (state) => ({
            state,
            needsBrief: state === "joined" && member.threadId !== "here-thread",
          }))
        : Effect.fail(new MissionError({ message: Missions.LEADS_NO_MISSION })),
    releaseMember: (input, asLead) =>
      Effect.suspend(() => {
        calls.push({ kind: "release", ...input, asLead });
        return input.member.threadId === "elsewhere"
          ? Effect.fail(new MissionError({ message: "That thread is not in this mission." }))
          : Effect.succeed("released" as const);
      }),
  });
  return { calls, heard, layer };
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const callLeadTool = (
  missions: ReturnType<typeof makeMissions>,
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: result.structuredContent as Record<string, unknown> | undefined,
    })),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(
          Layer.mergeAll(
            missions.layer,
            liveThreadsLayer,
            Layer.mock(Project.ProjectService)({}),
            noWorkspace,
            Layer.mock(MissionClaims.MissionClaims)({}),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );

it.effect("the roster pages the caller's own mission, and marks who needs the lead", () =>
  Effect.gen(function* () {
    const missions = makeMissions();
    const first = yield* callLeadTool(missions, lead, "t3_mission_roster", {});
    const page = first.structured as {
      readonly missionId: string;
      readonly members: ReadonlyArray<{
        readonly member: string;
        readonly place: string;
        readonly threadRef: ScopedThreadRef;
        readonly needsAttention: boolean;
        readonly title: string;
      }>;
      readonly total: number;
      readonly nextCursor: number | null;
    };
    assert.equal(page.missionId, MISSION);
    assert.lengthOf(page.members, 10);
    assert.deepEqual(
      page.members.slice(0, 2).map((member) => member.needsAttention),
      [true, false],
    );
    assert.equal(page.members[0]?.title, "Title 0");
    assert.deepEqual(
      [page.members[0]?.member, page.members[0]?.place, page.members[0]?.threadRef],
      ["member 1", "machine 2", { environmentId: LAPTOP, threadId: ThreadId.make("t0") }],
    );
    assert.equal(page.total, 12);
    assert.equal(page.nextCursor, 10);
    const rest = (yield* callLeadTool(missions, lead, "t3_mission_roster", {
      cursor: 10,
      limit: 500,
    })).structured as {
      readonly members: ReadonlyArray<unknown>;
      readonly nextCursor: number | null;
    };
    assert.lengthOf(rest.members, 2);
    assert.isNull(rest.nextCursor);
  }),
);

it.effect("add and release act on the caller's own mission, by the UI's rules", () =>
  Effect.gen(function* () {
    const missions = makeMissions();
    const add = (threadRef: Record<string, unknown>) =>
      callLeadTool(missions, lead, "t3_mission_add", { threadRef });
    assert.deepEqual((yield* add({ threadId: "here-thread" })).structured, { state: "joined" });
    assert.deepEqual((yield* add({ threadId: "worked" })).structured, {
      state: "joined",
      next: 'This thread has prior work. Get its brief before giving it new work: queue a message asking for it with t3_thread_send (mode "queue", outputSchema a JSON Schema object with additionalProperties false whose required "brief" property is a string with maxLength 4000), then call t3_thread_wait with the runId it returned and untilOutput: true. If the send is refused or the member is settled, read it with t3_thread_read (limit: 2, runLimit: 1, maxCharsPerItem: 4000) instead.',
    });
    assert.deepEqual((yield* add({ threadId: "t1", environmentId: LAPTOP })).structured, {
      state: "pending",
    });
    assert.include(
      (yield* add({ threadId: "t2", environmentId: FENCED })).text,
      "relink Fenced box with full access",
    );
    const released = yield* callLeadTool(missions, lead, "t3_mission_release", {
      threadRef: { threadId: "elsewhere" },
    });
    assert.include(released.text, "That thread is not in this mission.");
    assert.deepEqual(
      missions.calls.map((call) => [call.kind, call.missionId, call.member.environmentId]),
      [
        ["add", MISSION, HERE],
        ["add", MISSION, HERE],
        ["add", MISSION, LAPTOP],
        ["add", MISSION, FENCED],
        ["release", MISSION, HERE],
      ],
    );
    for (const call of missions.calls) assert.equal(call.asLead, lead.thread.threadId);
  }),
);

const created = (threadId: string) => ({
  threadId: ThreadId.make(threadId),
  runId: null,
  status: "idle" as const,
  title: threadId,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
});

const delegated = {
  taskId: NodeId.make("task-1"),
  childThreadId: ThreadId.make("child"),
  childRunId: null,
  childNodeId: NodeId.make("node-1"),
  status: "starting",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: null,
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
} as const;

const callOrchestratorTool = (
  missions: ReturnType<typeof makeMissions>,
  scope: McpInvocationContext.McpInvocationScope,
  name: "create_threads" | "delegate_task" | "t3_thread_wait",
  input: Record<string, unknown>,
  waited?: object,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      missions.layer,
      liveThreadsLayer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        createThreads: () => Effect.succeed({ threads: [created("new-1"), created("taken")] }),
        delegateTask: () => Effect.succeed(delegated),
        waitForThread: () => Effect.succeed(waited as never),
      }),
      Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
      Layer.mock(PeerForwarding.PeerForwarding)({ call: () => Effect.succeed(waited as never) }),
      Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      Layer.mock(PeerLinks.PeerLinks)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
    );
    const toolkit = yield* OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const results = yield* toolkit
      .handle(name, input as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result as Record<string, unknown> | OrchestratorMcpFailure;
  });

it.effect(
  "threads a lead creates join its mission; a refused join says why, and a child task joins none",
  () =>
    Effect.gen(function* () {
      const missions = makeMissions();
      const createdByLead = (yield* callOrchestratorTool(missions, lead, "create_threads", {
        threads: [{ title: "One" }, { title: "Two" }],
      })) as {
        readonly threads: ReadonlyArray<{ readonly threadId: string; readonly mission?: unknown }>;
      };
      assert.deepEqual(
        createdByLead.threads.map((thread) => [thread.threadId, thread.mission]),
        [
          ["new-1", { state: "joined" }],
          ["taken", { state: "refused", reason: 'This thread is already in the mission "Other".' }],
        ],
      );
      assert.deepEqual(
        missions.calls.map((call) => [call.missionId, call.member]),
        [
          [MISSION, { environmentId: HERE, threadId: "new-1" }],
          [MISSION, { environmentId: HERE, threadId: "taken" }],
        ],
      );

      const replayed = (yield* callOrchestratorTool(missions, lead, "create_threads", {
        threads: [{ title: "One" }, { title: "Two" }],
      })) as { readonly threads: ReadonlyArray<{ readonly mission?: unknown }> };
      for (const thread of replayed.threads) assert.notProperty(thread, "mission");

      const byOther = (yield* callOrchestratorTool(missions, notLead, "create_threads", {
        threads: [{ title: "One" }],
      })) as { readonly threads: ReadonlyArray<{ readonly mission?: unknown }> };
      assert.notProperty(byOther.threads[0], "mission");

      const child = (yield* callOrchestratorTool(missions, lead, "delegate_task", {
        task: "Look into it",
      })) as Record<string, unknown>;
      assert.equal(child.taskId, "task-1");
      assert.notProperty(child, "mission");
      assert.lengthOf(missions.calls, 2);
    }),
);

// What each launched thread saved, kept from its first launch as a replay keeps it.
const launchedOrigins = new Map<string, object>();

const callLaunch = (
  missions: ReturnType<typeof makeMissions>,
  scope: McpInvocationContext.McpInvocationScope,
  input: Record<string, unknown>,
  forwarded: Array<object> = [],
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      missions.layer,
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed({
            ...liveThreadShell(threadId),
            ...(threadId === stamped.thread.threadId
              ? { linkOrigin: { sessionId: "desk", label: "Desk", access: "full-access" as const } }
              : {}),
          }),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, _tool, _target, params) =>
          Effect.sync(() => {
            forwarded.push(params as object);
            return {
              threadId: ThreadId.make(`launched-${(params as { title: string }).title}`),
              projectId: (params as { projectId?: string }).projectId ?? "project-there",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              runId: null,
              status: null,
            } as never;
          }),
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) => Effect.succeedSome({ id, workspaceRoot: process.cwd() } as never),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (launch) =>
          Effect.sync(() => {
            // As thread.create, which keeps these only alongside linkOrigin.
            if (!launchedOrigins.has(launch.threadId!) && launch.linkOrigin !== undefined) {
              const { delegatedFrom, workflowRun } = launch;
              launchedOrigins.set(launch.threadId!, { delegatedFrom, workflowRun });
            }
            return {
              threadId: launch.threadId,
              projection: {
                thread: {
                  id: launch.threadId,
                  projectId: launch.projectId,
                  title: launch.title,
                  modelSelection: launch.modelSelection,
                  ...launchedOrigins.get(launch.threadId!),
                },
                runs: [],
              },
              resumed: false,
            } as never;
          }),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(DocumentText.DocumentText)({}),
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mission-launch-" }),
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle("t3_thread_launch", input as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result as {
      readonly threadId?: ThreadId;
      readonly projectId?: string;
      readonly mission?: unknown;
    };
  });

it.effect(
  "a member's and a lead's new threads join the mission in the caller's project; mission none and an outsider join none",
  () =>
    Effect.gen(function* () {
      const missions = makeMissions();
      const optedOut = yield* callLaunch(missions, inMission, { title: "Apart", mission: "none" });
      assert.isString(optedOut.threadId);
      assert.notProperty(optedOut, "mission");
      const forwarded: Array<object> = [];
      const away = {
        environmentId: LAPTOP,
        projectId: "project:there",
        title: "Away",
        mission: "none",
      };
      const awayLaunch = yield* callLaunch(missions, inMission, away, forwarded);
      assert.isString(awayLaunch.threadId);
      assert.equal(awayLaunch.projectId, "project:there");
      assert.notProperty(awayLaunch, "mission");
      assert.deepEqual(forwarded, [away]);
      const origins = {
        delegatedFrom: { environmentId: LAPTOP, threadId: "parent", title: "Parent" },
        workflowRun: { environmentId: LAPTOP, runId: "run-1", workflow: "ship", step: "build" },
      };
      for (const [field, origin] of Object.entries(origins)) {
        const fromLink = yield* callLaunch(missions, stamped, { title: field, [field]: origin });
        assert.isString(fromLink.threadId);
        assert.notProperty(fromLink, "mission");
      }
      const first = { title: "Again", clientRequestId: "again", ...origins };
      const replay = { title: "Again", clientRequestId: "again" };
      const launchedAgain = yield* callLaunch(missions, stamped, first);
      const replayed = yield* callLaunch(missions, stamped, replay);
      assert.equal(replayed.threadId, launchedAgain.threadId);
      assert.notProperty(replayed, "mission");
      const remote = yield* callLaunch(missions, inMission, {
        environmentId: LAPTOP,
        title: "Far",
      });
      assert.isString(remote.threadId);
      assert.notProperty(remote, "mission");
      const apart = (yield* callOrchestratorTool(missions, lead, "create_threads", {
        threads: [{ title: "Two" }],
        mission: "none",
      })) as {
        readonly threads: ReadonlyArray<{ readonly threadId: string; readonly mission?: unknown }>;
      };
      assert.isString(apart.threads[0]?.threadId);
      for (const thread of apart.threads) assert.notProperty(thread, "mission");
      assert.notProperty(yield* callLaunch(missions, notLead, { title: "Other" }), "mission");
      assert.deepEqual(missions.calls, []);

      const byMember = yield* callLaunch(missions, inMission, { title: "Fix" });
      assert.deepEqual(byMember.mission, { state: "joined" });
      assert.equal(byMember.projectId, "project:mcp-test");
      const named = yield* callLaunch(missions, inMission, {
        title: "Named",
        projectId: "project:other",
      });
      assert.equal(named.projectId, "project:other");
      assert.deepEqual(named.mission, { state: "joined" });
      const stampedPlain = yield* callLaunch(missions, stamped, { title: "Plain" });
      assert.deepEqual(stampedPlain.mission, { state: "joined" });
      const discarded = yield* callLaunch(missions, inMission, {
        title: "Discarded",
        delegatedFrom: origins.delegatedFrom,
      });
      assert.deepEqual(discarded.mission, { state: "joined" });
      const created = (yield* callOrchestratorTool(missions, inMission, "create_threads", {
        threads: [{ title: "One" }],
      })) as { readonly threads: ReadonlyArray<{ readonly mission?: unknown }> };
      assert.deepEqual(created.threads[0]?.mission, { state: "joined" });
      const byLead = yield* callLaunch(missions, lead, { title: "Review" });
      assert.deepEqual(byLead.mission, { state: "joined" });
      const leadsDelegated = yield* callLaunch(missions, lead, {
        title: "Delegated",
        delegatedFrom: origins.delegatedFrom,
      });
      assert.deepEqual(leadsDelegated.mission, { state: "joined" });
      assert.deepEqual(
        missions.calls.map((call) => [call.missionId, call.member.threadId, call.asLead]),
        [
          byMember.threadId,
          named.threadId,
          stampedPlain.threadId,
          discarded.threadId,
          "new-1",
          "taken",
          byLead.threadId,
          leadsDelegated.threadId,
        ].map((threadId) => [MISSION, threadId, lead.thread.threadId]),
      );
    }),
);

it.effect(
  "a thread a lead launches on a linked machine joins over that link, or says why not",
  () =>
    Effect.gen(function* () {
      const missions = makeMissions();
      const launch = (environmentId: EnvironmentId) =>
        callLaunch(missions, lead, { environmentId, title: environmentId });
      assert.deepEqual((yield* launch(LAPTOP)).mission, { state: "pending" });
      assert.notProperty(yield* launch(LAPTOP), "mission");
      assert.deepEqual((yield* launch(FENCED)).mission, {
        state: "refused",
        reason:
          "The link to Fenced box has auto access. A link below full access may change only threads it started, so relink Fenced box with full access to use its threads in a mission.",
      });
      assert.deepEqual(
        missions.calls.map((call) => call.member),
        [
          { environmentId: LAPTOP, threadId: `launched-${LAPTOP}` },
          { environmentId: FENCED, threadId: `launched-${FENCED}` },
        ],
      );
    }),
);

it.effect(
  "a thread a lead forks joins its mission once; a merge back and another caller's fork join none",
  () =>
    Effect.gen(function* () {
      const missions = makeMissions();
      const transfer = (scope: McpInvocationContext.McpInvocationScope, input: object) =>
        Effect.gen(function* () {
          const dependencies = Layer.mergeAll(
            missions.layer,
            Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
              getProjectThreadRecords: (input) =>
                Effect.succeed(idleThreadProjection(liveThreadShell(input.threadId)) as never),
              dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
            }),
            NodeCrypto.layer,
          );
          const toolkit = yield* ThreadToolkit.pipe(
            Effect.provide(
              McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
                Layer.provide(dependencies),
              ),
            ),
          );
          const results = yield* toolkit
            .handle("t3_thread_transfer", input as never)
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
          return results.at(-1)?.result as Record<string, unknown>;
        });
      const forked = yield* transfer(lead, { action: "fork" });
      assert.deepEqual(forked.mission, { state: "joined" });
      assert.deepEqual(
        missions.calls.map((call) => [call.kind, call.member.environmentId, call.asLead]),
        [["add", HERE, lead.thread.threadId]],
      );
      assert.equal(missions.calls[0]?.member.threadId, forked.targetThreadId);
      assert.notProperty(
        yield* transfer(lead, { action: "merge_back", targetThreadId: "other" }),
        "mission",
      );
      assert.notProperty(yield* transfer(notLead, { action: "fork" }), "mission");
      assert.notProperty(yield* transfer(inMission, { action: "fork" }), "mission");
      assert.lengthOf(missions.calls, 1);
    }),
);

it.effect("a thread that leads no mission is refused each lead tool, and nothing changes", () =>
  Effect.gen(function* () {
    const missions = makeMissions();
    for (const [tool, args] of [
      ["t3_mission_roster", {}],
      ["t3_mission_add", { threadRef: { threadId: "x" } }],
      ["t3_mission_release", { threadRef: { threadId: "x" } }],
    ] as const) {
      const answer = yield* callLeadTool(missions, notLead, tool, args);
      assert.include(answer.text, "This thread leads no mission.");
      assert.include(answer.text, "invalid_request");
    }
    assert.deepEqual(missions.calls, []);
  }),
);

it.effect(
  "a wait for a run's output that returns it completed tells Missions what it saw, here or on a linked machine",
  () =>
    Effect.gen(function* () {
      const missions = makeMissions();
      const member = ThreadId.make("member-thread");
      const answer = {
        threadId: member,
        runId: "run-1",
        status: "completed",
        timedOut: false,
        output: { brief: "Done." },
      };
      const wait = (
        scope: McpInvocationContext.McpInvocationScope,
        waited: object,
        environmentId?: EnvironmentId,
        asked: object = { untilOutput: true, runId: "run-1" },
      ) =>
        callOrchestratorTool(
          missions,
          scope,
          "t3_thread_wait",
          { threadId: member, ...asked, ...(environmentId === undefined ? {} : { environmentId }) },
          { ...answer, ...waited },
        );
      assert.deepEqual(yield* wait(lead, {}), answer);
      yield* wait(lead, {}, LAPTOP);
      yield* wait(notLead, {});
      yield* wait(lead, { timedOut: true });
      yield* wait(lead, { status: "failed" });
      yield* wait(lead, { runId: null });
      yield* wait(lead, { output: undefined });
      yield* wait(lead, {}, undefined, { runId: "run-1" });
      yield* wait(lead, {}, undefined, { untilOutput: true });
      assert.deepEqual(yield* wait(lead, { runId: "broken" }), { ...answer, runId: "broken" });
      assert.deepEqual(missions.heard, [
        [lead.thread.threadId, { environmentId: HERE, threadId: member }, "run-1"],
        [lead.thread.threadId, { environmentId: LAPTOP, threadId: member }, "run-1"],
        [notLead.thread.threadId, { environmentId: HERE, threadId: member }, "run-1"],
      ]);
    }),
);

it.effect("long roster labels are cut to fit 30,000 bytes, and a small workspace stays", () =>
  Effect.gen(function* () {
    const rows = [
      { ...row(0, "idle"), project: "p".repeat(40_000) },
      { ...row(1, "idle"), machine: "m".repeat(40_000) },
      row(2, "idle"),
      {
        ...row(3, "idle"),
        title: "t".repeat(40_000),
        workspace: {
          kind: "project" as const,
          repositories: [],
          truncated: false,
          otherPullRequests: [],
          stale: false,
        },
      },
    ];
    const missions = {
      ...makeMissions(),
      layer: Layer.mock(Missions.Missions)({
        ledBy: () =>
          Effect.succeed({
            missionId: MISSION,
            name: "Ship",
            leadThreadId: lead.thread.threadId,
            createdAt: "",
            prompt: "",
          }),
        roster: () => Effect.succeed(rows),
      }),
    };
    const seen: Array<string> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const { text, structured } = yield* callLeadTool(missions, lead, "t3_mission_roster", {
        cursor,
      });
      assert.isAtMost(Buffer.byteLength(text, "utf8"), 30_000);
      const page = structured as {
        readonly members: ReadonlyArray<{
          readonly threadRef: ScopedThreadRef;
          readonly title: string;
          readonly project: string;
          readonly machine: string;
          readonly workspace: unknown;
        }>;
        readonly nextCursor: number | null;
      };
      for (const member of page.members) {
        seen.push(
          `${member.threadRef.threadId} ${member.title.length < 40_000} ${member.project.length < 40_000} ${member.machine.length < 40_000} ${typeof member.workspace}`,
        );
      }
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, [
      "t0 true true true string",
      "t1 true true true string",
      "t2 true true true string",
      "t3 true true true object",
    ]);
  }),
);
