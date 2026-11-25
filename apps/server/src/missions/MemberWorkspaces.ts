import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  PullRequestState,
  repositoryGroupingKeyOf,
  type ThreadId,
} from "@t3tools/contracts";
import { withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

export const MEMBER_REPOSITORIES_MAX = 32;
/** How long one background read of a thread's checkouts may take before it is given up. */
export const WORKSPACE_READ_DEADLINE = Duration.seconds(10);
const WORKSPACE_CACHE_TTL = Duration.seconds(15);
const PROJECT_SCAN_CACHE_TTL = Duration.seconds(30);
const SHARED_CHECKOUT_BRANCH_CACHE_TTL = Duration.seconds(30);

const MemberPullRequest = Schema.Struct({
  number: Schema.Number,
  /** `unknown`: no saved snapshot of the pull request. */
  state: Schema.Union([PullRequestState, Schema.Literal("unknown")]),
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
  /** `live`: read from the shared checkout. `recorded`: the branch the thread's record names. */
  branchSource: Schema.Literals(["live", "recorded"]),
  /**
   * The key pull requests are matched by: its origin's canonical key, else its own, such as
   * `github.com/owner/name` or `dev.azure.com/org/project/_git/repo`. Null with no remote.
   */
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
  /** It has more than `MEMBER_REPOSITORIES_MAX` repositories, and the rest are left out. */
  truncated: Schema.Boolean,
  /** Pull requests linked to the thread from no repository it checks out, such as a review. */
  otherPullRequests: Schema.Array(
    Schema.Struct({ ...MemberPullRequest.fields, repository: Schema.String }),
  ),
  /** Read a while ago; a new read is under way. */
  stale: Schema.Boolean,
});
export type MemberWorkspace = typeof MemberWorkspace.Type;

/** `pending`: not read yet. `omitted`: left out to keep a list answer small. */
export const ListedWorkspace = Schema.Union([
  MemberWorkspace,
  Schema.Literals(["pending", "omitted"]),
]);
export type ListedWorkspace = typeof ListedWorkspace.Type;

type WorkspaceShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "worktreePath" | "branch" | "pullRequests"
>;

export class MemberWorkspaces extends Context.Service<
  MemberWorkspaces,
  {
    /** Reads the thread's checkouts now, however long that takes. */
    readonly of: (shell: WorkspaceShell) => Effect.Effect<MemberWorkspace>;
    /** Never waits: a missing or old read is started in the background. */
    readonly cached: (shell: WorkspaceShell) => Effect.Effect<MemberWorkspace | "pending">;
  }
>()("t3/missions/MemberWorkspaces") {}

const keyOf = (key: string) => sourceControlDefinitions.canonicalRepositoryKey(key);

interface Checkout {
  readonly name: string;
  readonly path: string;
  readonly repositoryPath: string;
}

interface Probed {
  readonly kind: MemberWorkspace["kind"];
  readonly truncated: boolean;
  readonly checkouts: ReadonlyArray<
    Checkout & {
      readonly liveBranch: string | null;
      readonly remote: string | null;
      readonly keys: ReadonlySet<string>;
    }
  >;
}

const placeOf = (shell: WorkspaceShell) => JSON.stringify([shell.projectId, shell.worktreePath]);
const ageBelow = (at: number, now: number, ttl: Duration.Duration) =>
  now - at < Duration.toMillis(ttl);

const make = Effect.gen(function* () {
  const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
  const taskFolders = yield* TaskFolderStore.TaskFolderStore;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* Project.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const background = yield* Effect.scope;
  const branches = new Map<string, { readonly at: number; readonly branch: string | null }>();
  const scans = new Map<
    ProjectId,
    { readonly at: number; readonly checkouts: ReadonlyArray<Checkout> }
  >();
  const reads = new Map<
    ThreadId,
    { readonly at: number; readonly place: string; readonly probed: Probed }
  >();
  const reading = new Set<ThreadId>();

  const branchOf = Effect.fn("MemberWorkspaces.branchOf")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    const read = branches.get(cwd);
    if (read !== undefined && ageBelow(read.at, now, SHARED_CHECKOUT_BRANCH_CACHE_TTL)) {
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

  const at = (folder: string, repositoryPath = folder): Checkout => ({
    name: path.basename(repositoryPath),
    path: folder,
    repositoryPath,
  });

  const projectCheckouts = Effect.fn("MemberWorkspaces.projectCheckouts")(function* (
    projectId: ProjectId,
    projectRoot: string | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const scan = scans.get(projectId);
    if (scan !== undefined && ageBelow(scan.at, now, PROJECT_SCAN_CACHE_TTL)) return scan.checkouts;
    const tracked = yield* workspaceFolders
      .forThread({ projectId, worktreePath: null })
      .pipe(Effect.orElseSucceed(() => ({ folders: [] })));
    const rootIsRepository =
      projectRoot !== null &&
      (yield* fileSystem
        .exists(path.join(projectRoot, ".git"))
        .pipe(Effect.orElseSucceed(() => false)));
    const checkouts = [
      ...(rootIsRepository ? [at(projectRoot)] : []),
      ...tracked.folders
        .filter((folder) => folder.isGitRepository && folder.path !== projectRoot)
        .map((folder) => ({ ...at(folder.path), name: folder.name })),
    ];
    scans.set(projectId, { at: now, checkouts });
    return checkouts;
  });

  const checkoutsOf = Effect.fn("MemberWorkspaces.checkoutsOf")(function* (shell: WorkspaceShell) {
    const projectRoot = yield* projects.getShell(shell.projectId).pipe(
      Effect.map((found) => (Option.isSome(found) ? found.value.workspaceRoot : null)),
      Effect.orElseSucceed(() => null),
    );
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
    return {
      kind: "project" as const,
      checkouts: yield* projectCheckouts(shell.projectId, projectRoot),
    };
  });

  const readNow = Effect.fn("MemberWorkspaces.readNow")(function* (shell: WorkspaceShell) {
    const { kind, checkouts } = yield* checkoutsOf(shell);
    const probed: Probed = {
      kind,
      truncated: checkouts.length > MEMBER_REPOSITORIES_MAX,
      checkouts: yield* Effect.forEach(
        checkouts.slice(0, MEMBER_REPOSITORIES_MAX),
        (checkout) =>
          Effect.gen(function* () {
            const identity = yield* identities.resolve(checkout.repositoryPath);
            return {
              ...checkout,
              liveBranch: kind === "project" ? yield* branchOf(checkout.path) : null,
              remote: identity === null ? null : keyOf(repositoryGroupingKeyOf(identity)),
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
      ),
    };
    reads.set(shell.id, { at: yield* Clock.currentTimeMillis, place: placeOf(shell), probed });
    return probed;
  });

  // The pull requests come from the thread as it is now, so an unlinked one never lingers.
  const workspaceOf = (probed: Probed, shell: WorkspaceShell, stale: boolean): MemberWorkspace => {
    const links = visibleThreadPullRequests(shell.pullRequests ?? []).map((link) => ({
      key: keyOf(`${link.host}/${link.repository}`),
      repository: `${link.host}/${link.repository}`,
      pullRequest: {
        number: link.number,
        state: link.snapshot?.state ?? ("unknown" as const),
        url: withoutRemoteUrlCredentials(link.url),
      },
    }));
    const live = probed.kind === "project";
    return {
      kind: probed.kind,
      repositories: probed.checkouts.map(({ keys, liveBranch, ...checkout }) => ({
        ...checkout,
        branch: live ? liveBranch : shell.branch,
        branchSource: live ? ("live" as const) : ("recorded" as const),
        pullRequests: links.flatMap((link) => (keys.has(link.key) ? [link.pullRequest] : [])),
      })),
      truncated: probed.truncated,
      otherPullRequests: links.flatMap((link) =>
        probed.checkouts.some(({ keys }) => keys.has(link.key))
          ? []
          : [{ ...link.pullRequest, repository: link.repository }],
      ),
      stale,
    };
  };

  const of = Effect.fn("MemberWorkspaces.of")(function* (shell: WorkspaceShell) {
    return workspaceOf(yield* readNow(shell), shell, false);
  });

  const cached = Effect.fn("MemberWorkspaces.cached")(function* (shell: WorkspaceShell) {
    const now = yield* Clock.currentTimeMillis;
    const found = reads.get(shell.id);
    const read = found?.place === placeOf(shell) ? found : undefined;
    const fresh = read !== undefined && ageBelow(read.at, now, WORKSPACE_CACHE_TTL);
    if (!fresh && !reading.has(shell.id)) {
      reading.add(shell.id);
      yield* readNow(shell).pipe(
        Effect.timeout(WORKSPACE_READ_DEADLINE),
        Effect.catchCause((cause) =>
          Effect.logInfo("A mission member's checkouts were not read", cause),
        ),
        Effect.ensuring(Effect.sync(() => reading.delete(shell.id))),
        Effect.forkIn(background),
      );
    }
    return read === undefined ? ("pending" as const) : workspaceOf(read.probed, shell, !fresh);
  });

  return MemberWorkspaces.of({ of, cached });
});

export const layer = Layer.effect(MemberWorkspaces, make);
