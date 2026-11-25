import { type OrchestrationV2ThreadShell, repositoryGroupingKeyOf } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Project from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const MemberPullRequest = Schema.Struct({
  number: Schema.Number,
  /** `open`, `closed` or `merged`, or `unknown` before its host was read. */
  state: Schema.String,
  url: Schema.String,
});

/** A repository a member's checkout covers, as its own machine reads it. */
export const MemberRepository = Schema.Struct({
  name: Schema.String,
  /** Where the member works in it. */
  path: Schema.String,
  /** The repository on that machine `path` is a checkout of. */
  repositoryPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** Its remote as `host/owner/name`, null with no remote. */
  remote: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(MemberPullRequest),
});
export type MemberRepository = typeof MemberRepository.Type;

/**
 * Where a member works. `project`: the project's own checkout, shared. `worktree`: one checkout of
 * its own. `task-folder`: a folder of its own with a worktree of each repository it chose.
 */
export const MemberWorkspace = Schema.Struct({
  kind: Schema.Literals(["project", "worktree", "task-folder"]),
  repositories: Schema.Array(MemberRepository),
  /** Pull requests linked to the thread from no repository it checks out, such as a review. */
  otherPullRequests: Schema.Array(
    Schema.Struct({ ...MemberPullRequest.fields, repository: Schema.String }),
  ),
});
export type MemberWorkspace = typeof MemberWorkspace.Type;

/** A shared checkout can change branch under a member; it is read again after this long. */
const BRANCH_READ_TTL = Duration.seconds(30);

export class MemberWorkspaces extends Context.Service<
  MemberWorkspaces,
  {
    readonly of: (
      shell: Pick<
        OrchestrationV2ThreadShell,
        "projectId" | "worktreePath" | "branch" | "pullRequests"
      >,
    ) => Effect.Effect<MemberWorkspace>;
  }
>()("t3/missions/MemberWorkspaces") {}

const keyOf = (key: string) => sourceControlDefinitions.canonicalRepositoryKey(key);

const make = Effect.gen(function* () {
  const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
  const taskFolders = yield* TaskFolderStore.TaskFolderStore;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* Project.ProjectService;
  const path = yield* Path.Path;
  const branches = new Map<string, { readonly at: number; readonly branch: string | null }>();

  const branchOf = Effect.fn("MemberWorkspaces.branchOf")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    const read = branches.get(cwd);
    if (read !== undefined && now - read.at < Duration.toMillis(BRANCH_READ_TTL)) {
      return read.branch;
    }
    const branch = yield* git
      .execute({
        operation: "MemberWorkspaces.branchOf",
        cwd,
        args: ["branch", "--show-current"],
        allowNonZeroExit: true,
      })
      .pipe(
        // Empty on a detached HEAD.
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
        Effect.orElseSucceed(() => null),
      );
    branches.set(cwd, { at: now, branch });
    return branch;
  });

  /** The checkouts a thread works in, and whether each is on the thread's own branch. */
  const checkoutsOf = Effect.fn("MemberWorkspaces.checkoutsOf")(function* (
    shell: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">,
  ) {
    const projectRoot = yield* projects.getShell(shell.projectId).pipe(
      Effect.map((found) => (Option.isSome(found) ? found.value.workspaceRoot : null)),
      Effect.orElseSucceed(() => null),
    );
    const at = (folder: string, repositoryPath = folder) => ({
      name: path.basename(repositoryPath),
      path: folder,
      repositoryPath,
    });
    if (shell.worktreePath !== null) {
      const taskFolder = yield* taskFolders
        .findContaining(shell.worktreePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (taskFolder === null) {
        return {
          kind: "worktree" as const,
          checkouts: [at(shell.worktreePath, projectRoot ?? shell.worktreePath)],
        };
      }
      // Every repository of a task folder is on the thread's branch.
      return {
        kind: "task-folder" as const,
        checkouts: [
          ...(taskFolder.projectIsWorktree
            ? [at(taskFolder.projectPath, taskFolder.projectRoot)]
            : []),
          ...taskFolder.repositories.map((repository) => ({
            name: repository.name,
            path: repository.worktreePath,
            repositoryPath: repository.repositoryPath,
          })),
        ],
      };
    }
    const tracked = yield* workspaceFolders
      .forThread({ projectId: shell.projectId, worktreePath: null })
      .pipe(Effect.orElseSucceed(() => ({ folders: [] })));
    const repositories = tracked.folders.filter((folder) => folder.isGitRepository);
    return {
      kind: "project" as const,
      checkouts:
        repositories.length > 0
          ? repositories.map((folder) => ({ ...at(folder.path), name: folder.name }))
          : projectRoot === null
            ? []
            : [at(projectRoot)],
    };
  });

  const of = Effect.fn("MemberWorkspaces.of")(function* (
    shell: Pick<
      OrchestrationV2ThreadShell,
      "projectId" | "worktreePath" | "branch" | "pullRequests"
    >,
  ) {
    const { kind, checkouts } = yield* checkoutsOf(shell);
    const read = yield* Effect.forEach(
      checkouts,
      (checkout) =>
        Effect.gen(function* () {
          const identity = yield* identities.resolve(checkout.repositoryPath);
          return {
            checkout,
            // A shared checkout is on whatever branch it is on now; the others, the thread's.
            branch: kind === "project" ? yield* branchOf(checkout.path) : shell.branch,
            remote: identity === null ? null : repositoryGroupingKeyOf(identity),
            keys: new Set(
              identity === null
                ? []
                : [identity.canonicalKey, identity.origin?.canonicalKey].flatMap((key) =>
                    key === undefined ? [] : [keyOf(key)],
                  ),
            ),
          };
        }),
      { concurrency: 4 },
    );
    const links = (shell.pullRequests ?? []).map((link) => ({
      key: keyOf(`${link.host}/${link.repository}`),
      repository: `${link.host}/${link.repository}`,
      pullRequest: { number: link.number, state: link.snapshot?.state ?? "unknown", url: link.url },
    }));
    return {
      kind,
      repositories: read.map(({ checkout, branch, remote, keys }) => ({
        ...checkout,
        branch,
        remote,
        pullRequests: links.flatMap((link) => (keys.has(link.key) ? [link.pullRequest] : [])),
      })),
      otherPullRequests: links.flatMap((link) =>
        read.some(({ keys }) => keys.has(link.key))
          ? []
          : [{ ...link.pullRequest, repository: link.repository }],
      ),
    } satisfies MemberWorkspace;
  });

  return MemberWorkspaces.of({ of });
});

export const layer = Layer.effect(MemberWorkspaces, make);
