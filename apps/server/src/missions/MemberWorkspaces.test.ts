import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Project from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as MemberWorkspaces from "./MemberWorkspaces.ts";

const projectId = ProjectId.make("project:app");
const identity = (repository: string): RepositoryIdentity => ({
  canonicalKey: `github.com/${repository}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `git@github.com:${repository}.git`,
  },
});
const link = (repository: string, number: number, state: "open" | "merged" | null) =>
  ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    snapshot: state === null ? null : { state },
  }) as never;

/** One machine: a project at /code/app with two repositories, and a single-repository one. */
const machine = (gitCalls: Array<string>) =>
  MemberWorkspaces.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TaskFolderStore.TaskFolderStore)({
          findContaining: (target) =>
            Effect.succeed(
              target.startsWith("/tasks/one")
                ? {
                    root: "/tasks/one",
                    projectId,
                    projectRoot: "/code/app",
                    anchor: "/code",
                    projectPath: "/tasks/one/app",
                    projectIsWorktree: false,
                    repositories: [
                      {
                        repositoryPath: "/code/app/api",
                        worktreePath: "/tasks/one/app/api",
                        name: "api",
                      },
                      {
                        repositoryPath: "/code/app/web",
                        worktreePath: "/tasks/one/app/web",
                        name: "web",
                      },
                    ],
                  }
                : null,
            ),
        }),
        Layer.mock(WorkspaceFolders.WorkspaceFolders)({
          forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: (cwd) =>
            Effect.succeed(
              cwd === "/code/app/api"
                ? identity("acme/api")
                : cwd === "/code/app/web"
                  ? identity("acme/web")
                  : null,
            ),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: (input) =>
            Effect.sync(() => {
              gitCalls.push(input.cwd);
              return {
                exitCode: 0,
                stdout: "main\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } as never;
            }),
        }),
        Layer.mock(Project.ProjectService)({
          getShell: () => Effect.succeedSome({ workspaceRoot: "/code/solo" } as never),
        }),
        NodeServices.layer,
      ),
    ),
  );

it.effect(
  "a task folder lists each repository on the thread's branch, with its own pull requests",
  () => {
    const gitCalls: Array<string> = [];
    return Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* workspaces.of({
        projectId,
        worktreePath: "/tasks/one/app",
        branch: "t3/checkout-v2",
        pullRequests: [
          link("acme/api", 12, "open"),
          link("acme/web", 7, "merged"),
          link("acme/docs", 3, null),
        ],
      });
      assert.deepEqual(workspace, {
        kind: "task-folder",
        repositories: [
          {
            name: "api",
            path: "/tasks/one/app/api",
            repositoryPath: "/code/app/api",
            branch: "t3/checkout-v2",
            remote: "github.com/acme/api",
            pullRequests: [
              { number: 12, state: "open", url: "https://github.com/acme/api/pull/12" },
            ],
          },
          {
            name: "web",
            path: "/tasks/one/app/web",
            repositoryPath: "/code/app/web",
            branch: "t3/checkout-v2",
            remote: "github.com/acme/web",
            pullRequests: [
              { number: 7, state: "merged", url: "https://github.com/acme/web/pull/7" },
            ],
          },
        ],
        // A review of another repository stays with the thread, apart from its checkouts.
        otherPullRequests: [
          {
            number: 3,
            state: "unknown",
            url: "https://github.com/acme/docs/pull/3",
            repository: "github.com/acme/docs",
          },
        ],
      });
      // Its branch is the thread's: no Git is run for it.
      assert.deepEqual(gitCalls, []);
    }).pipe(Effect.provide(machine(gitCalls)));
  },
);

it.effect("a member in the project's own checkout reads its branch there, once in a while", () => {
  const gitCalls: Array<string> = [];
  return Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const shell = { projectId, worktreePath: null, branch: null, pullRequests: [] };
    const expected = {
      kind: "project" as const,
      repositories: [
        {
          name: "solo",
          path: "/code/solo",
          repositoryPath: "/code/solo",
          branch: "main",
          remote: null,
          pullRequests: [],
        },
      ],
      otherPullRequests: [],
    };
    assert.deepEqual(yield* workspaces.of(shell), expected);
    assert.deepEqual(yield* workspaces.of(shell), expected);
    assert.deepEqual(gitCalls, ["/code/solo"]);
  }).pipe(Effect.provide(machine(gitCalls)));
});
