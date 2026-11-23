import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
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
const agentHere: McpInvocationContext.McpInvocationScope = {
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

const tagOnce = (scope: McpInvocationContext.McpInvocationScope) => {
  const tags = new Map<ThreadId, Array<string>>([
    [userThread, []],
    [agentHere.thread!.threadId, []],
  ]);
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        tags.has(threadId)
          ? { ...liveThreadShell(threadId, { runtimeMode: "auto" }), tags: tags.get(threadId) }
          : null,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type === "thread.tag.set" && command.tagged) {
          tags.get(command.threadId)!.push(command.tag);
        }
        return {} as never;
      }),
  });
  return McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({
        name: "t3_mission_tag",
        arguments: { threadId: userThread, change: "join", missionId: "m1", name: "Ship" },
      }),
    ),
    Effect.map(({ content }) => ({
      answer: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      tags: tags.get(userThread),
    })),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(Layer.merge(threads, NodeCrypto.layer)),
      ),
    ),
  );
};

it.effect("a full-access link tags a thread it did not start", () =>
  Effect.gen(function* () {
    const { tags } = yield* tagOnce(linkedClient("full-access"));
    assert.deepEqual(tags, ["mission:m1:Ship"]);
  }),
);

it.effect("a link below full access is fenced off the user's threads", () =>
  Effect.gen(function* () {
    const { answer, tags } = yield* tagOnce(linkedClient("auto"));
    assert.include(answer, "capability_denied");
    assert.deepEqual(tags, []);
  }),
);

it.effect("an agent on this machine is not offered the tool and cannot call it", () =>
  Effect.gen(function* () {
    const refused = yield* tagOnce(agentHere).pipe(Effect.flip);
    assert.include(refused.message, "Tool 't3_mission_tag' not found");
  }),
);
