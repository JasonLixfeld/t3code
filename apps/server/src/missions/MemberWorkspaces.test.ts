import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  type RepositoryIdentity,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Project from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import type { MemberRepository } from "@t3tools/contracts";
import * as MemberWorkspaces from "./MemberWorkspaces.ts";

const projectId = ProjectId.make("project:app");
const threadId = ThreadId.make("thread:one");
const identity = (remoteUrl: string): RepositoryIdentity => ({
  canonicalKey: sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl),
  locator: { source: "git-remote", remoteName: "origin", remoteUrl },
});
const github = (repository: string) => identity(`git@github.com:${repository}.git`);
const link = (
  url: string,
  state: "open" | "merged" | null,
  source: ThreadPullRequestLink["source"] = "manual",
): ThreadPullRequestLink => {
  const key = normalizeThreadPullRequestKey(
    sourceControlDefinitions.parseChangeRequestUrl(url)!.link,
  );
  return {
    ...key,
    url,
    source,
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot:
      state === null
        ? null
        : {
            state,
            title: `#${key.number}`,
            headBranch: "t3/checkout-v2",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-01-01T00:00:00.000Z",
          },
    stack: null,
  };
};
const projectAt = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "app",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const folder = (path: string, isGitRepository = true) => ({
  name: path.split("/").at(-1)!,
  path,
  isGitRepository,
});
const noLinks: ReadonlyArray<ThreadPullRequestLink> = [];
const inProject = (
  overrides: {
    readonly id?: ThreadId;
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  } = {},
) => ({
  id: threadId,
  projectId,
  worktreePath: null,
  branch: null,
  pullRequests: noLinks,
  ...overrides,
});

type Service = MemberWorkspaces.MemberWorkspaces["Service"];
const READ_STEP = "1 millis";
const readAfterBackgroundRead = (workspaces: Service, shell: Parameters<Service["cached"]>[0]) =>
  Effect.gen(function* () {
    yield* workspaces.cached(shell);
    yield* TestClock.adjust(READ_STEP);
    const workspace = yield* workspaces.cached(shell);
    return workspace === "pending" ? yield* Effect.die("The workspace was never read.") : workspace;
  });

interface Machine {
  readonly projectRoot?: string;
  readonly tracked?: ReadonlyArray<ReturnType<typeof folder>>;
  readonly repositories?: ReadonlyArray<string>;
  readonly identities?: Readonly<Record<string, RepositoryIdentity>>;
  readonly resolve?: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

const machine = (gitCalls: Array<string>, options: Machine = {}) =>
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
          forThread: () => Effect.succeed({ folders: options.tracked ?? [], extraRoots: [] }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve:
            options.resolve ??
            ((cwd) =>
              Effect.succeed(
                (
                  options.identities ?? {
                    "/code/app/api": github("acme/api"),
                    "/code/app/web": github("acme/web"),
                  }
                )[cwd] ?? null,
              )),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: (input) =>
            Effect.sync(() => {
              gitCalls.push(input.cwd);
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "main\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
        Layer.mock(Project.ProjectService)({
          getShell: () =>
            Effect.sleep(READ_STEP).pipe(
              Effect.andThen(Effect.succeedSome(projectAt(options.projectRoot ?? "/code/solo"))),
            ),
        }),
        FileSystem.layerNoop({
          exists: (target) =>
            Effect.succeed(
              (options.repositories ?? ["/code/solo"]).some(
                (repository) => target === `${repository}/.git`,
              ),
            ),
        }),
        Path.layer,
      ),
    ),
  );

const repository = (
  path: string,
  repositoryPath: string,
  branch: string | null,
  remote: string | null,
  pullRequests: MemberRepository["pullRequests"] = [],
): MemberRepository => ({
  name: repositoryPath.split("/").at(-1)!,
  path,
  repositoryPath,
  branch,
  branchSource: branch === "main" ? "live" : "recorded",
  remote,
  pullRequests,
});

it.effect(
  "a task folder lists each repository on the thread's recorded branch, with its own pull requests",
  () => {
    const gitCalls: Array<string> = [];
    return Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* readAfterBackgroundRead(workspaces, {
        id: threadId,
        projectId,
        worktreePath: "/tasks/one/app",
        branch: "t3/checkout-v2",
        pullRequests: [
          link("https://github.com/acme/api/pull/12", "open"),
          link("https://github.com/acme/web/pull/7", "merged"),
          link("https://github.com/acme/docs/pull/3", null),
        ],
      });
      assert.deepEqual(workspace, {
        kind: "task-folder",
        repositories: [
          repository(
            "/tasks/one/app/api",
            "/code/app/api",
            "t3/checkout-v2",
            "github.com/acme/api",
            [{ number: 12, state: "open", url: "https://github.com/acme/api/pull/12" }],
          ),
          repository(
            "/tasks/one/app/web",
            "/code/app/web",
            "t3/checkout-v2",
            "github.com/acme/web",
            [{ number: 7, state: "merged", url: "https://github.com/acme/web/pull/7" }],
          ),
        ],
        truncated: false,
        otherPullRequests: [
          {
            number: 3,
            state: "unknown",
            url: "https://github.com/acme/docs/pull/3",
            repository: "github.com/acme/docs",
          },
        ],
        stale: false,
      });
      assert.deepEqual(gitCalls, []);
    }).pipe(Effect.provide(machine(gitCalls)));
  },
);

it.effect("a member in the project's own checkout reads its branch there, once in a while", () => {
  const gitCalls: Array<string> = [];
  return Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const expected = {
      kind: "project" as const,
      repositories: [repository("/code/solo", "/code/solo", "main", null)],
      truncated: false,
      otherPullRequests: [],
      stale: false,
    };
    assert.deepEqual(yield* readAfterBackgroundRead(workspaces, inProject()), expected);
    assert.deepEqual(yield* readAfterBackgroundRead(workspaces, inProject()), expected);
    assert.deepEqual(gitCalls, ["/code/solo"]);
  }).pipe(Effect.provide(machine(gitCalls)));
});

it.effect("a shared checkout lists its root repository and the repositories it tracks", () =>
  Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const workspace = yield* readAfterBackgroundRead(
      workspaces,
      inProject({
        pullRequests: [
          link("https://github.com/acme/app/pull/1", "open"),
          link("https://github.com/acme/api/pull/2", "open"),
        ],
      }),
    );
    assert.deepEqual(workspace.repositories, [
      repository("/code/app", "/code/app", "main", "github.com/acme/app", [
        { number: 1, state: "open", url: "https://github.com/acme/app/pull/1" },
      ]),
      repository("/code/app/api", "/code/app/api", "main", "github.com/acme/api", [
        { number: 2, state: "open", url: "https://github.com/acme/api/pull/2" },
      ]),
    ]);
    assert.deepEqual(workspace.otherPullRequests, []);
  }).pipe(
    Effect.provide(
      machine([], {
        projectRoot: "/code/app",
        tracked: [folder("/code/app/api")],
        repositories: ["/code/app", "/code/app/api"],
        identities: { "/code/app": github("acme/app"), "/code/app/api": github("acme/api") },
      }),
    ),
  ),
);

it.effect("a plain project folder is no repository; the repositories it tracks are", () =>
  Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const workspace = yield* readAfterBackgroundRead(workspaces, inProject());
    assert.deepEqual(
      workspace.repositories.map((checkout) => checkout.path),
      ["/code/app/api", "/code/app/web"],
    );
  }).pipe(
    Effect.provide(
      machine([], {
        projectRoot: "/code/app",
        tracked: [
          folder("/code/app/api"),
          folder("/code/app/web"),
          folder("/code/app/notes", false),
        ],
        repositories: ["/code/app/api", "/code/app/web"],
      }),
    ),
  ),
);

it.effect(
  "a project that tracks 128 repositories lists the first 32, and says it left some out",
  () => {
    const tracked = Array.from({ length: 128 }, (_, index) => folder(`/code/app/repo-${index}`));
    return Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* readAfterBackgroundRead(workspaces, inProject());
      assert.equal(workspace.repositories.length, MemberWorkspaces.MEMBER_REPOSITORIES_MAX);
      assert.equal(workspace.repositories.at(-1)?.path, "/code/app/repo-31");
      assert.isTrue(workspace.truncated);
    }).pipe(
      Effect.provide(
        machine([], {
          projectRoot: "/code/app",
          tracked,
          repositories: tracked.map((repository) => repository.path),
        }),
      ),
    );
  },
);

it.effect(
  "a hung repository probe never holds up a read, and is given up after its deadline",
  () => {
    let probes = 0;
    const members = ["thread:a", "thread:b", "thread:c"].map((id) =>
      inProject({ id: ThreadId.make(id) }),
    );
    return Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const readAll = Effect.forEach(members, (member) => workspaces.cached(member));
      assert.deepEqual(yield* readAll, ["pending", "pending", "pending"]);
      yield* TestClock.adjust(READ_STEP);
      assert.deepEqual(yield* readAll, ["pending", "pending", "pending"]);
      yield* TestClock.adjust(READ_STEP);
      assert.equal(probes, 3);
      yield* TestClock.adjust(MemberWorkspaces.WORKSPACE_READ_DEADLINE);
      assert.deepEqual(yield* readAll, ["pending", "pending", "pending"]);
      yield* TestClock.adjust(READ_STEP);
      assert.equal(probes, 6);
    }).pipe(
      Effect.provide(
        machine([], {
          resolve: () =>
            Effect.suspend(() => {
              probes += 1;
              return Effect.never;
            }),
        }),
      ),
    );
  },
);

it.effect("a cached read answers at once, then goes stale and is read again", () => {
  const gitCalls: Array<string> = [];
  return Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    assert.equal(yield* workspaces.cached(inProject()), "pending");
    yield* TestClock.adjust(READ_STEP);
    const fresh = yield* workspaces.cached(inProject());
    assert.isFalse(typeof fresh === "string" || fresh.stale);
    yield* TestClock.adjust("1 minute");
    const stale = yield* workspaces.cached(inProject());
    assert.isTrue(typeof stale !== "string" && stale.stale);
  }).pipe(Effect.provide(machine(gitCalls)));
});

it.effect(
  "a dismissed stack pull request is left out, and a pull request URL loses its login",
  () =>
    Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* readAfterBackgroundRead(workspaces, {
        ...inProject(),
        pullRequests: [
          link("https://ci-bot:ghp_secret@github.com/acme/app/pull/4?token=abc", "open"),
          link("https://github.com/acme/app/pull/5", "open", "stack-dismissed"),
        ],
      });
      assert.deepEqual(workspace.repositories[0]?.pullRequests, [
        { number: 4, state: "open", url: "https://github.com/acme/app/pull/4" },
      ]);
      assert.deepEqual(workspace.otherPullRequests, []);
    }).pipe(
      Effect.provide(
        machine([], {
          projectRoot: "/code/app",
          repositories: ["/code/app"],
          identities: { "/code/app": github("acme/app") },
        }),
      ),
    ),
);

it.effect(
  "an Azure DevOps repository is keyed as its pull requests are, whatever its spelling",
  () =>
    Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* readAfterBackgroundRead(workspaces, {
        ...inProject(),
        pullRequests: [
          link("https://dev.azure.com/acme/Proj/_git/Repo/pullrequest/7", "open"),
          link(
            "https://tfs.example.com:8443/tfs/DefaultCollection/Proj/_git/Server/pullrequest/5",
            "open",
          ),
        ],
      });
      assert.deepEqual(
        workspace.repositories.map((checkout) => [
          checkout.remote,
          checkout.pullRequests.map((pullRequest) => pullRequest.number),
        ]),
        [
          ["dev.azure.com/acme/proj/_git/repo", [7]],
          ["tfs.example.com:8443/tfs/defaultcollection/proj/_git/server", [5]],
        ],
      );
      assert.deepEqual(workspace.otherPullRequests, []);
    }).pipe(
      Effect.provide(
        machine([], {
          projectRoot: "/code/app",
          tracked: [folder("/code/app/repo"), folder("/code/app/server")],
          repositories: ["/code/app/repo", "/code/app/server"],
          identities: {
            "/code/app/repo": identity("https://acme.visualstudio.com/Proj/_git/Repo"),
            "/code/app/server": identity(
              "https://tfs.example.com:8443/tfs/DefaultCollection/Proj/_git/Server",
            ),
          },
        }),
      ),
    ),
);

it.effect(
  "two servers on one host, on two ports, are two repositories with their own pull requests",
  () =>
    Effect.gen(function* () {
      const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
      const workspace = yield* readAfterBackgroundRead(workspaces, {
        ...inProject(),
        pullRequests: [
          link(
            "https://tfs.example.com:8443/tfs/DefaultCollection/Proj/_git/Repo/pullrequest/1",
            "open",
          ),
          link(
            "https://tfs.example.com:9443/tfs/DefaultCollection/Proj/_git/Repo/pullrequest/2",
            "open",
          ),
          link(
            "https://tfs.example.com/tfs/DefaultCollection/Proj/_git/Repo/pullrequest/3",
            "open",
          ),
        ],
      });
      assert.deepEqual(
        workspace.repositories.map((checkout) => [
          checkout.remote,
          checkout.pullRequests.map((pullRequest) => pullRequest.number),
        ]),
        [
          ["tfs.example.com:8443/tfs/defaultcollection/proj/_git/repo", [1]],
          ["tfs.example.com:9443/tfs/defaultcollection/proj/_git/repo", [2]],
          ["tfs.example.com/tfs/defaultcollection/proj/_git/repo", [3]],
        ],
      );
    }).pipe(
      Effect.provide(
        machine([], {
          projectRoot: "/code/app",
          tracked: [folder("/code/app/a"), folder("/code/app/b"), folder("/code/app/ssh")],
          repositories: ["/code/app/a", "/code/app/b", "/code/app/ssh"],
          identities: {
            "/code/app/a": identity(
              "https://tfs.example.com:8443/tfs/DefaultCollection/Proj/_git/Repo",
            ),
            "/code/app/b": identity(
              "https://tfs.example.com:9443/tfs/DefaultCollection/Proj/_git/Repo",
            ),
            "/code/app/ssh": identity(
              "ssh://tfs.example.com:22/tfs/DefaultCollection/Proj/_git/Repo",
            ),
          },
        }),
      ),
    ),
);

it.effect("a forgotten thread is read again from the start", () => {
  const gitCalls: Array<string> = [];
  return Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    yield* readAfterBackgroundRead(workspaces, inProject());
    yield* workspaces.forget(threadId);
    assert.equal(yield* workspaces.cached(inProject()), "pending");
  }).pipe(Effect.provide(machine(gitCalls)));
});

it.effect("a read that ends after its thread is forgotten stores nothing", () => {
  const gate = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    assert.equal(yield* workspaces.cached(inProject()), "pending");
    yield* TestClock.adjust(READ_STEP);
    yield* workspaces.forget(threadId);
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust(READ_STEP);
    assert.equal(yield* workspaces.cached(inProject()), "pending");
  }).pipe(
    Effect.provide(
      machine([], {
        resolve: () =>
          Deferred.await(gate).pipe(Effect.andThen(Effect.sleep(READ_STEP)), Effect.as(null)),
      }),
    ),
  );
});

it.effect("past its cap the cache drops the thread read least recently", () =>
  Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const thread = (index: number) => inProject({ id: ThreadId.make(`thread:${index}`) });
    for (let index = 0; index < MemberWorkspaces.CACHE_ENTRIES_MAX; index += 1) {
      yield* readAfterBackgroundRead(workspaces, thread(index));
    }
    yield* readAfterBackgroundRead(workspaces, thread(0));
    yield* readAfterBackgroundRead(workspaces, thread(MemberWorkspaces.CACHE_ENTRIES_MAX));
    assert.notEqual(yield* workspaces.cached(thread(0)), "pending");
    assert.equal(yield* workspaces.cached(thread(1)), "pending");
  }).pipe(Effect.provide(machine([]))),
);

it.effect("a pull request two checkouts both match goes to neither", () =>
  Effect.gen(function* () {
    const workspaces = yield* MemberWorkspaces.MemberWorkspaces;
    const workspace = yield* readAfterBackgroundRead(workspaces, {
      ...inProject(),
      pullRequests: [link("https://github.com/acme/api/pull/4", "open")],
    });
    assert.deepEqual(
      workspace.repositories.map((checkout) => checkout.pullRequests),
      [[], []],
    );
    assert.deepEqual(
      workspace.otherPullRequests.map((pullRequest) => pullRequest.number),
      [4],
    );
  }).pipe(
    Effect.provide(
      machine([], {
        projectRoot: "/code/app",
        tracked: [folder("/code/app/api"), folder("/code/app/api-copy")],
        repositories: ["/code/app/api", "/code/app/api-copy"],
        identities: {
          "/code/app/api": github("acme/api"),
          "/code/app/api-copy": github("acme/api"),
        },
      }),
    ),
  ),
);
