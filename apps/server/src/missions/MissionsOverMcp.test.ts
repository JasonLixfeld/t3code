import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MissionClaimResult,
  type MissionsSnapshot,
  type OrchestrationProjectShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import { MemberWorkspaces } from "./MemberWorkspaces.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as MissionHandlers from "../mcp/toolkits/mission/handlers.ts";
import { MissionToolkit } from "../mcp/toolkits/mission/tools.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MissionClaims from "./MissionClaims.ts";
import * as MissionTurnContexts from "./MissionTurnContexts.ts";
import * as MissionStore from "./MissionStore.ts";
import * as Missions from "./Missions.ts";

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
const webProject: OrchestrationProjectShell = {
  id: ProjectId.make("project-web"),
  title: "web",
  workspaceRoot: "/code/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const LINK_TOKEN = "desk-link-token";
const LINK_SESSION = "desk-link-session";
const TAG = "mission:0123456789ab:One";

const threadsWith = (tags: Map<string, Array<string>>) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.sync(() => {
        const current = tags.get(threadId);
        return current === undefined
          ? null
          : {
              ...liveThreadShell(threadId),
              title: "One",
              latestUserMessageAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
              tags: [...current],
            };
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type !== "thread.tag.set") throw new Error(`unexpected ${command.type}`);
        const current = tags.get(command.threadId)!;
        if (command.tagged) current.push(command.tag);
        else current.splice(current.indexOf(command.tag), 1);
        return {} as never;
      }),
  });

it.effect("join, list, release and leave go through the laptop's real /mcp", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missions-mcp-" });
    const deskTags = new Map([["lead", [] as Array<string>]]);
    const laptopTags = new Map([
      ["added", [] as Array<string>],
      ["found", [] as Array<string>],
    ]);
    const claimsOn = (machine: string, tags: Map<string, Array<string>>) =>
      MissionClaims.layer.pipe(
        Layer.provideMerge(MissionStore.layerFromPath(`${directory}/${machine}.sqlite`)),
        Layer.provide(
          Layer.mergeAll(
            threadsWith(tags),
            NodeCrypto.layer,
            ThreadCommandExecutor.layer,
            noWorkspace,
            Layer.mock(Project.ProjectService)({
              getShell: () => Effect.succeedSome(webProject),
            }),
          ),
        ),
      );

    const laptopClaims = Context.get(
      yield* Layer.build(claimsOn("laptop", laptopTags)),
      MissionClaims.MissionClaims,
    );
    const settings = yield* Layer.build(ServerSettings.layerTest());
    const projects = Layer.merge(
      Layer.mock(Project.ProjectService)({
        getShell: () => Effect.succeedSome(webProject),
      }),
      noWorkspace,
    );
    yield* Context.get(settings, ServerSettings.ServerSettingsService).updateSettings({
      linkedEnvironmentsEnabled: true,
    });
    const laptopMcp = McpHttpServer.layerMcpTransport(
      Layer.mergeAll(
        McpHttpServer.toolkitRegistration(MissionToolkit, MissionHandlers.layer),
        McpHttpServer.layerToolSearch,
      ),
    ).pipe(
      Layer.provide(Layer.succeedContext(settings)),
      Layer.provide(
        Layer.mergeAll(
          threadsWith(laptopTags),
          NodeCrypto.layer,
          Layer.succeed(MissionClaims.MissionClaims, laptopClaims),
          projects,
        ),
      ),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: () => Effect.undefined,
        }),
      ),
      Layer.provide(
        Layer.succeed(McpHttpServer.McpClientAuthenticator)({
          authenticate: (request) =>
            Effect.succeed(
              request.headers.authorization === `Bearer ${LINK_TOKEN}`
                ? {
                    environmentId: LAPTOP,
                    requestNamespace: `client:${LINK_SESSION}`,
                    thread: undefined,
                    client: {
                      sessionId: LINK_SESSION,
                      label: "T3 Code · Desk",
                      access: "full-access" as const,
                      linked: true,
                    },
                    capabilities: new Set(["orchestration" as const]),
                    issuedAt: 0,
                  }
                : undefined,
            ),
        }),
      ),
    );
    yield* HttpRouter.serve(laptopMcp, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const { address } = yield* HttpServer.HttpServer;
    if (NetAddress.isUnixPathAddress(address)) return assert.fail("The test server has no port.");
    const laptopUrl = (yield* Effect.fromResult(NetAddress.toUrl(address))).origin;

    const link = {
      environmentId: LAPTOP,
      label: "Laptop",
      access: "full-access",
      linkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"),
    };
    const desk = Missions.layer.pipe(
      Layer.provide(claimsOn("desk", deskTags)),
      Layer.provide(threadsWith(deskTags)),
      Layer.provideMerge(PeerMcpClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            names: Effect.succeed([{ environmentId: LAPTOP, label: "Laptop" }]),
            get: () => Effect.succeedSome(link as never),
            resolve: () => Effect.succeed({ link, url: laptopUrl, token: LINK_TOKEN } as never),
            recordOutcome: () => Effect.void,
            recordExpiry: () => Effect.void,
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(DESK),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            findThread: () => Effect.succeed(null),
            getThreadSettlements: (threadIds) =>
              Effect.succeed(
                new Map(
                  threadIds
                    .filter((threadId) => deskTags.has(threadId))
                    .map((threadId) => [threadId, { settledOverride: null, archivedAt: null }]),
                ),
              ),
          }),
          Layer.succeedContext(settings),
          projects,
          MissionTurnContexts.layer,
          NodeCrypto.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const missions = yield* Missions.Missions;
      const unknownKind = yield* (yield* PeerMcpClient.PeerMcpClient)
        .call({
          environmentId: LAPTOP,
          tool: "t3_mission_tag",
          arguments: { kind: "bogus" },
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: MissionClaimResult,
        })
        .pipe(Effect.flip);
      assert.equal(unknownKind.code, "invalid_request");
      const membersWhen = (matches: (threadIds: ReadonlyArray<string>) => boolean) =>
        missions.watch({ links: true, prompts: true }).pipe(
          Stream.map((snapshot: MissionsSnapshot) =>
            snapshot.missions[0]!.members.map((member) => member.ref.threadId as string),
          ),
          Stream.filter(matches),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      const mission = yield* missions.create({
        missionId: "0123456789ab",
        leadThreadId: ThreadId.make("lead"),
      });
      const added = { environmentId: LAPTOP, threadId: ThreadId.make("added") };
      const found = { environmentId: LAPTOP, threadId: ThreadId.make("found") };

      yield* missions.addMember({ missionId: mission.missionId, member: added });
      assert.deepEqual(laptopTags.get("added"), [TAG]);

      yield* laptopClaims.join(MissionClaims.linkOwner(LINK_SESSION), {
        threadId: found.threadId,
        missionId: mission.missionId,
        name: mission.name,
      });
      assert.deepEqual(yield* membersWhen((threadIds) => threadIds.includes("found")), [
        "lead",
        "added",
        "found",
      ]);
      const foundRow = (yield* missions.roster(mission.missionId)).find(
        (row) => row.ref.threadId === found.threadId,
      );
      assert.deepEqual(foundRow?.workspace, {
        kind: "project",
        repositories: [],
        truncated: false,
        otherPullRequests: [],
        stale: false,
      });

      yield* missions.releaseMember({ missionId: mission.missionId, member: added });
      assert.deepEqual(laptopTags.get("added"), ["mission-was:0123456789ab:One"]);

      yield* laptopClaims.leaveHere(found.threadId);
      assert.deepEqual(yield* membersWhen((threadIds) => !threadIds.includes("found")), ["lead"]);
    }).pipe(Effect.provide(desk));
  }).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer)), Effect.scoped),
);
