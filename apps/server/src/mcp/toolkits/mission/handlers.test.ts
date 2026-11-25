import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MissionError,
  type OrchestrationProjectShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import {
  layer as memberWorkspacesLayer,
  MemberWorkspaces,
} from "../../../missions/MemberWorkspaces.ts";
import * as MissionClaims from "../../../missions/MissionClaims.ts";
import * as Missions from "../../../missions/Missions.ts";
import * as MissionStore from "../../../missions/MissionStore.ts";
import type { MissionClaim } from "../../../missions/MissionStore.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as TaskFolderStore from "../../../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../../../workspace/WorkspaceFolders.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as MissionHandlers from "./handlers.ts";
import { MissionToolkit } from "./tools.ts";

const userThread = ThreadId.make("thread:user");

const emptyWorkspace = {
  kind: "project" as const,
  repositories: [],
  truncated: false,
  otherPullRequests: [],
  stale: false,
};
const noWorkspace = Layer.mock(MemberWorkspaces)({
  cached: () => Effect.succeed(emptyWorkspace),
  forget: () => Effect.void,
});
const appProject: OrchestrationProjectShell = {
  id: liveThreadShell(userThread).projectId,
  title: "app",
  workspaceRoot: "/code/app",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
/** The real workspace reads, on a machine where every repository probe hangs. */
const hungWorkspaces = memberWorkspacesLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(TaskFolderStore.TaskFolderStore)({ findContaining: () => Effect.succeed(null) }),
      Layer.mock(WorkspaceFolders.WorkspaceFolders)({
        forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.never,
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(Project.ProjectService)({ getShell: () => Effect.succeedSome(appProject) }),
      FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
      Path.layer,
    ),
  ),
);
const decodeTagAnswer = Schema.decodeUnknownSync(MissionToolkit.tools.t3_mission_tag.successSchema);

const linkedClient = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:link",
  thread: undefined,
  client: { sessionId: "link", label: "T3 Code · Desk", access, linked: true },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const agentHere: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:agent",
  thread: {
    threadId: ThreadId.make("thread:agent"),
    providerSessionId: "provider:agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
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

/**
 * Calls the tool once on a machine whose one user thread starts with `tags`. With `startedByLink`,
 * that thread was started by the calling link, so the link's fence lets it through.
 */
const callOnce = (
  scope: McpInvocationContext.McpInvocationScope,
  /** Built from the claim `before` made, when the call has to name it. */
  args:
    | Record<string, unknown>
    | ((before: MissionClaim | "intent-spent" | undefined) => Record<string, unknown>),
  options: {
    readonly startedByLink?: boolean;
    readonly before?: (
      claims: MissionClaims.MissionClaims["Service"],
    ) => Effect.Effect<MissionClaim | "intent-spent", MissionError>;
    /** Tag writes fail while `before` runs, so it leaves a thread whose tags are behind its claim. */
    readonly tagWritesFailBefore?: boolean;
    /** The user raises the thread to full access right after the tool's first look at it. */
    readonly modeRisesAfterFirstLook?: boolean;
    readonly runtimeMode?: "auto" | "full-access";
    readonly workspaces?: Layer.Layer<MemberWorkspaces>;
    /** Runs on the machine's first workspace read, as a slow list reads it. */
    readonly duringFirstWorkspaceRead?: (
      claims: MissionClaims.MissionClaims["Service"],
    ) => Effect.Effect<void, MissionError>;
    /** This machine's Missions, which sends its threads the brief requests. */
    readonly missions?: Partial<Missions.Missions["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-tool-" });
    const tags: Array<string> = [];
    let tagWritesFail = options.tagWritesFailBefore === true;
    let runtimeMode = options.runtimeMode ?? "auto";
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const modeNow = runtimeMode;
          if (options.modeRisesAfterFirstLook === true) runtimeMode = "full-access";
          return threadId === userThread || threadId === agentHere.thread.threadId
            ? {
                ...liveThreadShell(threadId, { runtimeMode: modeNow }),
                ...(options.startedByLink === true
                  ? {
                      linkOrigin: {
                        sessionId: "link",
                        label: "T3 Code · Desk",
                        access: "auto" as const,
                      },
                    }
                  : {}),
                tags: [...tags],
              }
            : null;
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          if (tagWritesFail) throw new Error("disk full");
          if (command.type === "thread.tag.set") {
            if (command.tagged) tags.push(command.tag);
            else tags.splice(tags.indexOf(command.tag), 1);
          }
          return {} as never;
        }),
    });
    let claimsHere: MissionClaims.MissionClaims["Service"] | undefined;
    let workspaceReads = 0;
    const workspaces =
      options.workspaces ??
      Layer.mock(MemberWorkspaces)({
        cached: () =>
          Effect.gen(function* () {
            workspaceReads += 1;
            if (workspaceReads === 1 && options.duringFirstWorkspaceRead !== undefined) {
              yield* options.duringFirstWorkspaceRead(claimsHere!).pipe(Effect.orDie);
            }
            return emptyWorkspace;
          }),
        forget: () => Effect.void,
      });
    const machine = Layer.mergeAll(
      threads,
      NodeCrypto.layer,
      ThreadCommandExecutor.layer,
      Layer.mock(Project.ProjectService)({
        getShell: () => Effect.succeedSome({ title: "web" } as never),
      }),
      workspaces,
    );
    const member = yield* Layer.build(
      MissionClaims.layer.pipe(
        Layer.provideMerge(MissionStore.layerFromPath(`${directory}/missions.sqlite`)),
        Layer.provide(machine),
      ),
    );
    const claims = Context.get(member, MissionClaims.MissionClaims);
    claimsHere = claims;
    const before = options.before === undefined ? undefined : yield* options.before(claims);
    tagWritesFail = false;
    const { content } = yield* McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({
          name: "t3_mission_tag",
          arguments: typeof args === "function" ? args(before) : args,
        }),
      ),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(
            Layer.mergeAll(
              machine,
              Layer.succeed(MissionClaims.MissionClaims, claims),
              options.missions === undefined
                ? Layer.empty
                : Layer.mock(Missions.Missions)(options.missions),
            ),
          ),
        ),
      ),
    );
    return {
      answer: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      tags,
      // Read before the machine's database closes.
      held: yield* Context.get(member, MissionStore.MissionStore).allClaims,
    };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const SHIP = "0123456789ab";
const joinShip = { kind: "join", threadId: userThread, missionId: SHIP, name: "Ship" };

it.effect("a link's lead asks its own member here for a brief, and reads the answer listed", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    let generation = "";
    const missions = {
      requestBriefHere: (input: unknown) =>
        Effect.sync(() => {
          asked.push(input);
          return "asked" as const;
        }),
      // Only the answer asked under the claim listed now, never one from an earlier claim.
      briefAnswer: (_threadId: ThreadId, under: string) =>
        Effect.succeed(under === generation ? { text: "Goal: ship." } : { text: "Stale." }),
    };
    const joinFirst = (claims: MissionClaims.MissionClaims["Service"]) =>
      claims
        .join(MissionClaims.linkOwner("link"), {
          threadId: userThread,
          missionId: SHIP,
          name: "Ship",
        })
        .pipe(
          Effect.tap((claim) =>
            Effect.sync(() => {
              if (claim !== "intent-spent") generation = claim.generation;
            }),
          ),
        );
    const ask = { kind: "brief", threadId: userThread, missionId: SHIP, askedAt: 7 };
    const { answer } = yield* callOnce(linkedClient("full-access"), ask, {
      before: joinFirst,
      missions,
    });
    assert.deepEqual(JSON.parse(answer), { claims: [], brief: "asked" });
    assert.deepEqual(asked, [{ missionId: SHIP, threadId: userThread, askedAt: 7, generation }]);
    // Not this link's member here: it is not asked.
    const refused = yield* callOnce(linkedClient("full-access"), ask, { missions });
    assert.include(refused.answer, "That thread is not in this mission.");
    assert.lengthOf(asked, 1);
    const listed = yield* callOnce(
      linkedClient("full-access"),
      { kind: "list" },
      {
        before: joinFirst,
        missions,
      },
    );
    assert.deepEqual(JSON.parse(listed.answer).claims[0].detail.brief, { text: "Goal: ship." });
  }),
);

it.effect("a full-access link claims and tags a thread it did not start", () =>
  Effect.gen(function* () {
    const { tags } = yield* callOnce(linkedClient("full-access"), joinShip);
    assert.deepEqual(tags, [`mission:${SHIP}:Ship`]);
  }),
);

it.effect("a mission id or name that a mission could not be started with is refused", () =>
  Effect.gen(function* () {
    for (const broken of [{ missionId: "ship:it" }, { name: "two\nlines" }]) {
      const refused = yield* callOnce(linkedClient("full-access"), {
        ...joinShip,
        ...broken,
      }).pipe(Effect.flip);
      assert.include(refused.message, "Invalid parameters for tool 't3_mission_tag'");
    }
  }),
);

it.effect("a link below full access is fenced off the user's threads", () =>
  Effect.gen(function* () {
    const { answer, tags } = yield* callOnce(linkedClient("auto"), joinShip);
    assert.include(answer, "capability_denied");
    assert.deepEqual(tags, []);
  }),
);

it.effect("a fenced link that started a thread cannot strip another lead's claim", () =>
  Effect.gen(function* () {
    const { tags, held } = yield* callOnce(
      linkedClient("auto"),
      (held) => ({
        kind: "release",
        threadId: userThread,
        missionId: SHIP,
        generation: typeof held === "object" ? held.generation : "none",
      }),
      {
        startedByLink: true,
        before: (claims) =>
          claims.join("env-other-lead", { threadId: userThread, missionId: SHIP, name: "Ship" }),
      },
    );
    assert.deepEqual(tags, [`mission:${SHIP}:Ship`]);
    assert.equal(held.length, 1);
  }),
);

it.effect("a fenced link that lists its claims writes no tag on a thread it does not own", () =>
  Effect.gen(function* () {
    const { answer, tags, held } = yield* callOnce(
      linkedClient("auto"),
      { kind: "list" },
      {
        tagWritesFailBefore: true,
        before: (claims) =>
          claims.join("env-other-lead", { threadId: userThread, missionId: SHIP, name: "Ship" }),
      },
    );
    assert.equal(answer, '{"claims":[]}');
    assert.equal(held.length, 1);
    assert.deepEqual(tags, []);
  }),
);

it.effect("a join is refused when the thread's mode rose while it waited for the lock", () =>
  Effect.gen(function* () {
    const { answer, tags, held } = yield* callOnce(linkedClient("auto"), joinShip, {
      startedByLink: true,
      modeRisesAfterFirstLook: true,
    });
    assert.include(answer, "runtime_mode_escalation_denied");
    assert.deepEqual(held, []);
    assert.deepEqual(tags, []);
  }),
);

const LINK_OWNER = MissionClaims.linkOwner("link");
const renameShip = { kind: "rename", missionId: SHIP, name: "Ship it" };
const joinedBy = (owner: string) => (claims: MissionClaims.MissionClaims["Service"]) =>
  claims.join(owner, { threadId: userThread, missionId: SHIP, name: "Ship" });
const namesOf = (held: ReadonlyArray<MissionClaim>) =>
  held.map((claim) => [claim.missionId, claim.role, claim.name]);

it.effect("a link renames its own claim, and only the name and tag change", () =>
  Effect.gen(function* () {
    const { tags, held } = yield* callOnce(linkedClient("full-access"), renameShip, {
      before: joinedBy(LINK_OWNER),
    });
    assert.deepEqual(tags, [`mission:${SHIP}:Ship it`]);
    assert.deepEqual(namesOf(held), [[SHIP, "member", "Ship it"]]);
  }),
);

it.effect("a link, full access or fenced, cannot rename another lead's claim", () =>
  Effect.gen(function* () {
    for (const [access, startedByLink] of [
      ["full-access", false],
      ["auto", true],
    ] as const) {
      const { tags, held } = yield* callOnce(linkedClient(access), renameShip, {
        startedByLink,
        before: joinedBy("env-other-lead"),
      });
      assert.deepEqual(tags, [`mission:${SHIP}:Ship`]);
      assert.deepEqual(namesOf(held), [[SHIP, "member", "Ship"]]);
    }
  }),
);

it.effect("a rename with no claim makes none, and one for another mission changes nothing", () =>
  Effect.gen(function* () {
    const none = yield* callOnce(linkedClient("full-access"), renameShip);
    assert.deepEqual([none.tags, none.held], [[], []]);
    const other = yield* callOnce(
      linkedClient("full-access"),
      { ...renameShip, missionId: "ba9876543210" },
      { before: joinedBy(LINK_OWNER) },
    );
    assert.deepEqual(other.tags, [`mission:${SHIP}:Ship`]);
    assert.deepEqual(namesOf(other.held), [[SHIP, "member", "Ship"]]);
  }),
);

it.effect("a rename to a name a mission could not have is refused", () =>
  Effect.gen(function* () {
    const refused = yield* callOnce(linkedClient("full-access"), {
      ...renameShip,
      name: "two\nlines",
    }).pipe(Effect.flip);
    assert.include(refused.message, "Invalid parameters for tool 't3_mission_tag'");
  }),
);

it.effect("a link lowered to auto cannot rename its claim on a full-access thread", () =>
  Effect.gen(function* () {
    const { tags, held } = yield* callOnce(linkedClient("auto"), renameShip, {
      startedByLink: true,
      runtimeMode: "full-access",
      before: joinedBy(LINK_OWNER),
    });
    assert.deepEqual(tags, [`mission:${SHIP}:Ship`]);
    assert.deepEqual(namesOf(held), [[SHIP, "member", "Ship"]]);
  }),
);

it.effect("an agent on this machine is not offered the tool and cannot call it", () =>
  Effect.gen(function* () {
    const refused = yield* callOnce(agentHere, joinShip).pipe(Effect.flip);
    assert.include(refused.message, "Tool 't3_mission_tag' not found");
  }),
);

const LEAD_TOOLS = ["t3_mission_roster", "t3_mission_add", "t3_mission_release"];
const leadHere = {
  ...agentHere,
  requestNamespace: "provider:lead",
  thread: { ...agentHere.thread, threadId: ThreadId.make("thread:lead") },
};

it.effect(
  "over /mcp, only a linked environment's session lists t3_mission_tag, and only a lead the lead tools",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsContext = yield* Layer.build(ServerSettings.layerTest());
        // On, as on any machine that links: the tool must still stay away from agents.
        yield* Context.get(settingsContext, ServerSettings.ServerSettingsService).updateSettings({
          linkedEnvironmentsEnabled: true,
        });
        const serverLayer = McpHttpServer.layerMcpTransport(
          Layer.mergeAll(
            McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer),
            McpHttpServer.layerToolSearch,
          ),
        ).pipe(
          Layer.provide(Layer.succeedContext(settingsContext)),
          Layer.provide(
            Layer.mergeAll(
              liveThreadsLayer,
              NodeCrypto.layer,
              Layer.mock(MissionClaims.MissionClaims)({}),
              Layer.mock(Project.ProjectService)({}),
              noWorkspace,
              Layer.mock(Missions.Missions)({
                ledBy: (threadId) =>
                  Effect.succeed(
                    threadId === leadHere.thread.threadId
                      ? ({ missionId: SHIP } as never)
                      : undefined,
                  ),
              }),
            ),
          ),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(
                  token === "agentToken" ? agentHere : token === "leadToken" ? leadHere : undefined,
                ),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator)({
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === "Bearer linkToken"
                    ? linkedClient("full-access")
                    : request.headers.authorization === "Bearer cliToken"
                      ? {
                          ...linkedClient("full-access"),
                          client: {
                            sessionId: "cli",
                            label: "CLI",
                            access: "full-access" as const,
                          },
                        }
                      : undefined,
                ),
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const rpc = (token: string, method: string, params: object) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            const response = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                "application/json",
              ),
            });
            const text = yield* response.text;
            const messages = text.startsWith("data:")
              ? text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => JSON.parse(line.slice(5)) as { readonly id?: number })
              : [JSON.parse(text) as { readonly id?: number }];
            return messages.find((message) => message.id === 2) as {
              readonly result?: {
                readonly tools?: ReadonlyArray<{ readonly name: string }>;
                readonly structuredContent?: { readonly tools?: ReadonlyArray<{ name: string }> };
              };
            };
          });
        const listed = (token: string) =>
          rpc(token, "tools/list", {}).pipe(
            Effect.map((body) => body.result?.tools?.map((tool) => tool.name) ?? []),
          );

        assert.notInclude(yield* listed("agentToken"), "t3_mission_tag");
        const searched = yield* rpc("agentToken", "tools/call", {
          name: "tool_search",
          arguments: { query: "t3_mission_tag mission tag" },
        });
        assert.deepEqual(searched.result?.structuredContent?.tools ?? [], []);
        assert.notInclude(yield* listed("cliToken"), "t3_mission_tag");
        assert.include(yield* listed("linkToken"), "t3_mission_tag");

        const lead = yield* listed("leadToken");
        assert.includeMembers(lead, LEAD_TOOLS);
        assert.notInclude(lead, "t3_mission_tag");
        for (const token of ["agentToken", "linkToken", "cliToken"]) {
          const others = yield* listed(token);
          for (const tool of LEAD_TOOLS) assert.notInclude(others, tool);
        }
        const refused = yield* rpc("agentToken", "tools/call", {
          name: "t3_mission_roster",
          arguments: {},
        });
        assert.include(JSON.stringify(refused), "Tool 't3_mission_roster' not found");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a list answers every member's status at once while its repositories are still read",
  () =>
    Effect.gen(function* () {
      const agentThread = agentHere.thread.threadId;
      const { answer } = yield* callOnce(
        linkedClient("full-access"),
        { kind: "list" },
        {
          workspaces: hungWorkspaces,
          before: (claims) =>
            joinedBy(LINK_OWNER)(claims).pipe(
              Effect.andThen(
                claims.join(LINK_OWNER, { threadId: agentThread, missionId: SHIP, name: "Ship" }),
              ),
            ),
        },
      );
      assert.deepEqual(
        decodeTagAnswer(JSON.parse(answer)).claims.map(
          (claim) => `${claim.threadId} ${claim.detail?.status} ${String(claim.detail?.workspace)}`,
        ),
        [`${userThread} working pending`, `${agentThread} working pending`],
      );
    }),
);

it.effect(
  "a thread whose claim changes hands while the list reads it is listed with no detail",
  () =>
    Effect.gen(function* () {
      const { answer } = yield* callOnce(
        linkedClient("full-access"),
        { kind: "list" },
        {
          before: joinedBy(LINK_OWNER),
          missions: { briefAnswer: () => Effect.succeed({ text: "Goal: ship." }) },
          duringFirstWorkspaceRead: (claims) =>
            Effect.gen(function* () {
              const [held] = yield* claims.list(LINK_OWNER);
              yield* claims.release(LINK_OWNER, {
                threadId: userThread,
                missionId: SHIP,
                generation: held!.generation,
              });
              yield* joinedBy("env-other-lead")(claims);
            }),
        },
      );
      const [listed] = decodeTagAnswer(JSON.parse(answer)).claims;
      assert.equal(listed?.threadId, userThread);
      assert.isUndefined(listed?.detail);
    }),
);

/** A workspace of about 30 KB, so one list answer has room for only one. */
const largeWorkspace = {
  ...emptyWorkspace,
  otherPullRequests: Array.from({ length: 300 }, (_, number) => ({
    number,
    state: "open" as const,
    url: `https://github.com/acme/app/pull/${number}?${"x".repeat(40)}`,
    repository: "github.com/acme/app",
  })),
};
const largeWorkspaces = Layer.mock(MemberWorkspaces)({
  cached: () => Effect.succeed(largeWorkspace),
  forget: () => Effect.void,
});
const NEWER = "fedcba987654";

it.effect(
  "a newer mission's member is omitted from a full list, and its workspace comes in the follow-up",
  () =>
    Effect.gen(function* () {
      const agentThread = agentHere.thread.threadId;
      const newer = { threadId: agentThread, missionId: NEWER, name: "Next" };
      const before = (claims: MissionClaims.MissionClaims["Service"]) =>
        joinedBy(LINK_OWNER)(claims).pipe(Effect.andThen(claims.join(LINK_OWNER, newer)));
      const workspaceOf = (answer: string) =>
        decodeTagAnswer(JSON.parse(answer)).claims.map((claim) => [
          claim.missionId,
          typeof claim.detail?.workspace === "object" ? "workspace" : claim.detail?.workspace,
        ]);
      const list = yield* callOnce(
        linkedClient("full-access"),
        { kind: "list" },
        { workspaces: largeWorkspaces, before },
      );
      assert.deepEqual(workspaceOf(list.answer), [
        [SHIP, "workspace"],
        [NEWER, "omitted"],
      ]);
      const followUp = yield* callOnce(
        linkedClient("full-access"),
        (held) => ({
          kind: "workspaces",
          members: [
            { threadId: agentThread, generation: typeof held === "object" ? held.generation : "" },
          ],
        }),
        { workspaces: largeWorkspaces, before },
      );
      assert.deepEqual(workspaceOf(followUp.answer), [[NEWER, "workspace"]]);
    }),
);

it.effect("a workspaces call answers only the caller's own claims, under their generations", () =>
  Effect.gen(function* () {
    const { answer } = yield* callOnce(
      linkedClient("full-access"),
      {
        kind: "workspaces",
        members: [
          { threadId: userThread, generation: "an-older-claim" },
          { threadId: agentHere.thread.threadId, generation: "not-the-callers" },
        ],
      },
      {
        before: (claims) =>
          joinedBy(LINK_OWNER)(claims).pipe(
            Effect.andThen(
              claims.join("env-other-lead", {
                threadId: agentHere.thread.threadId,
                missionId: SHIP,
                name: "Ship",
              }),
            ),
          ),
      },
    );
    assert.equal(answer, '{"claims":[]}');
  }),
);

it.effect(
  "a workspaces call for a claim that changes hands while it is read answers no detail",
  () =>
    Effect.gen(function* () {
      const { answer } = yield* callOnce(
        linkedClient("full-access"),
        (held) => ({
          kind: "workspaces",
          members: [
            { threadId: userThread, generation: typeof held === "object" ? held.generation : "" },
          ],
        }),
        {
          before: joinedBy(LINK_OWNER),
          duringFirstWorkspaceRead: (claims) =>
            Effect.gen(function* () {
              const [held] = yield* claims.list(LINK_OWNER);
              yield* claims.release(LINK_OWNER, {
                threadId: userThread,
                missionId: SHIP,
                generation: held!.generation,
              });
              yield* joinedBy("env-other-lead")(claims);
            }),
        },
      );
      const [listed] = decodeTagAnswer(JSON.parse(answer)).claims;
      assert.equal(listed?.threadId, userThread);
      assert.isUndefined(listed?.detail);
    }),
);

it.effect("a workspaces call for more than eight members is refused", () =>
  Effect.gen(function* () {
    const refused = yield* callOnce(linkedClient("full-access"), {
      kind: "workspaces",
      members: Array.from({ length: 9 }, (_, index) => ({
        threadId: `thread:${index}`,
        generation: "g",
      })),
    }).pipe(Effect.flip);
    assert.include(refused.message, "Invalid parameters for tool 't3_mission_tag'");
  }),
);
