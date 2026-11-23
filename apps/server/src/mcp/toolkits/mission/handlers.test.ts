import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type MissionError, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as MissionClaims from "../../../missions/MissionClaims.ts";
import * as MissionStore from "../../../missions/MissionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as MissionHandlers from "./handlers.ts";
import { MissionToolkit } from "./tools.ts";

const userThread = ThreadId.make("thread:user");

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
  args: Record<string, unknown>,
  options: {
    readonly startedByLink?: boolean;
    readonly before?: (
      claims: MissionClaims.MissionClaims["Service"],
    ) => Effect.Effect<unknown, MissionError>;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-tool-" });
    const tags: Array<string> = [];
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.sync(() =>
          threadId === userThread || threadId === agentHere.thread.threadId
            ? {
                ...liveThreadShell(threadId, { runtimeMode: "auto" }),
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
            : null,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "thread.tag.set") {
            if (command.tagged) tags.push(command.tag);
            else tags.splice(tags.indexOf(command.tag), 1);
          }
          return {} as never;
        }),
    });
    const machine = Layer.merge(threads, NodeCrypto.layer);
    const claims = Context.get(
      yield* Layer.build(
        MissionClaims.layer.pipe(
          Layer.provide(MissionStore.layerFromPath(`${directory}/missions.sqlite`)),
          Layer.provide(machine),
        ),
      ),
      MissionClaims.MissionClaims,
    );
    if (options.before !== undefined) yield* options.before(claims);
    const { content } = yield* McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: "t3_mission_tag", arguments: args })),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(
            Layer.merge(machine, Layer.succeed(MissionClaims.MissionClaims, claims)),
          ),
        ),
      ),
    );
    return {
      answer: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      tags,
      // Read before the machine's database closes.
      otherLeadClaims: yield* claims.list("env-other-lead"),
    };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const joinShip = { kind: "join", threadId: userThread, missionId: "m1", name: "Ship" };

it.effect("a full-access link claims and tags a thread it did not start", () =>
  Effect.gen(function* () {
    const { tags } = yield* callOnce(linkedClient("full-access"), joinShip);
    assert.deepEqual(tags, ["mission:m1:Ship"]);
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
    const { answer, tags, otherLeadClaims } = yield* callOnce(
      linkedClient("auto"),
      { kind: "leave", threadId: userThread, missionId: "m1" },
      {
        startedByLink: true,
        before: (claims) =>
          claims.join("env-other-lead", { threadId: userThread, missionId: "m1", name: "Ship" }),
      },
    );
    assert.include(answer, "Only the mission that holds this thread can release it.");
    assert.deepEqual(tags, ["mission:m1:Ship"]);
    assert.equal(otherLeadClaims.length, 1);
  }),
);

it.effect("an agent on this machine is not offered the tool and cannot call it", () =>
  Effect.gen(function* () {
    const refused = yield* callOnce(agentHere, joinShip).pipe(Effect.flip);
    assert.include(refused.message, "Tool 't3_mission_tag' not found");
  }),
);

it.effect("over /mcp, only a linked environment's session lists t3_mission_tag", () =>
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
          ),
        ),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(token === "agentToken" ? agentHere : undefined),
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
                        client: { sessionId: "cli", label: "CLI", access: "full-access" as const },
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
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
