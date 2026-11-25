import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  PullRequestState,
  type RepositoryIdentity,
  type ThreadId,
} from "@t3tools/contracts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
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
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

export const MEMBER_REPOSITORIES_MAX = 32;
/** How long one background read of a thread's checkouts may take before it is given up. */
export const WORKSPACE_READ_DEADLINE = Duration.seconds(10);
const WORKSPACE_CACHE_TTL = Duration.seconds(15);
const PROJECT_SCAN_CACHE_TTL = Duration.seconds(30);
const SHARED_CHECKOUT_BRANCH_CACHE_TTL = Duration.seconds(30);
/** Entries kept in each cache; the least recently used goes first. */
export const CACHE_ENTRIES_MAX = 512;

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
   * The key pull requests are matched by: its origin's, else its own, such as
   * `github.com/owner/name`, `dev.azure.com/org/project/_git/repo` or, for a server on an
   * explicit HTTP port, `tfs.example.com:8443/tfs/collection/project/_git/repo`. Null with no remote.
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

/**
 * `pending`: not read yet. `omitted`: left out to keep a list answer small; a follow-up sends it.
 * `tooLarge`: bigger than a whole answer may be, so it is never sent.
 */
export const ListedWorkspace = Schema.Union([
  MemberWorkspace,
  Schema.Literals(["pending", "omitted", "tooLarge"]),
]);
export type ListedWorkspace = typeof ListedWorkspace.Type;

type WorkspaceShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "worktreePath" | "branch" | "pullRequests"
>;

export class MemberWorkspaces extends Context.Service<
  MemberWorkspaces,
  {
    /** Never waits: a missing or old read is started in the background. */
    readonly cached: (shell: WorkspaceShell) => Effect.Effect<MemberWorkspace | "pending">;
    /** Drops what is known of a thread. A read of it still under way then stores nothing. */
    readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/missions/MemberWorkspaces") {}

const keyOf = (key: string) => sourceControlDefinitions.canonicalRepositoryKey(key);

/**
 * A repository's key as a saved pull request key spells it: an HTTP remote's explicit port is
 * kept, as a pull request URL's is. An SSH remote names no HTTP port, so its key has none, and
 * it matches only pull requests whose URL names no port either.
 */
const repositoryKeyOf = (canonicalKey: string, remoteUrl: string | undefined) => {
  const remote = remoteUrl === undefined ? null : parseGitRemoteHost(remoteUrl);
  const [host = "", ...path] = canonicalKey.split("/");
  const key = normalizeThreadPullRequestKey({
    host,
    repository: path.join("/"),
    number: 1,
    ...(remote !== null && remote.host !== remote.hostname ? { authority: remote.host } : {}),
  });
  return `${key.host}/${key.repository}`;
};
const repositoryKeysOf = (identity: RepositoryIdentity) => [
  ...(identity.origin === undefined
    ? []
    : [repositoryKeyOf(identity.origin.canonicalKey, identity.origin.remoteUrl)]),
  repositoryKeyOf(identity.canonicalKey, identity.locator.remoteUrl),
];

/** Reads an entry as the most recently used. */
const recall = <K, V>(cache: Map<K, V>, key: K) => {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
};
const remember = <K, V>(cache: Map<K, V>, key: K, value: V) => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_ENTRIES_MAX) cache.delete(cache.keys().next().value!);
};

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
  // The read under way for each thread. A read stores its result only while it is still this one.
  const reading = new Map<ThreadId, symbol>();

  const branchOf = Effect.fn("MemberWorkspaces.branchOf")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    const read = recall(branches, cwd);
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
    remember(branches, cwd, { at: now, branch });
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
    const scan = recall(scans, projectId);
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
    remember(scans, projectId, { at: now, checkouts });
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
            const keys = identity === null ? [] : repositoryKeysOf(identity);
            return {
              ...checkout,
              liveBranch: kind === "project" ? yield* branchOf(checkout.path) : null,
              remote: keys[0] ?? null,
              keys: new Set(keys),
            };
          }),
        { concurrency: 4 },
      ),
    };
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
    // A pull request two checkouts both match belongs to neither.
    const ownerOf = (key: string) => {
      const owners = probed.checkouts.filter((checkout) => checkout.keys.has(key));
      return owners.length === 1 ? owners[0] : undefined;
    };
    return {
      kind: probed.kind,
      repositories: probed.checkouts.map((checkout) => ({
        name: checkout.name,
        path: checkout.path,
        repositoryPath: checkout.repositoryPath,
        branch: live ? checkout.liveBranch : shell.branch,
        branchSource: live ? ("live" as const) : ("recorded" as const),
        remote: checkout.remote,
        pullRequests: links.flatMap((link) =>
          ownerOf(link.key) === checkout ? [link.pullRequest] : [],
        ),
      })),
      truncated: probed.truncated,
      otherPullRequests: links.flatMap((link) =>
        ownerOf(link.key) !== undefined
          ? []
          : [{ ...link.pullRequest, repository: link.repository }],
      ),
      stale,
    };
  };

  const cached = Effect.fn("MemberWorkspaces.cached")(function* (shell: WorkspaceShell) {
    const now = yield* Clock.currentTimeMillis;
    const found = recall(reads, shell.id);
    const read = found?.place === placeOf(shell) ? found : undefined;
    const fresh = read !== undefined && ageBelow(read.at, now, WORKSPACE_CACHE_TTL);
    if (!fresh && !reading.has(shell.id)) {
      const token = Symbol(shell.id);
      reading.set(shell.id, token);
      const current = () => reading.get(shell.id) === token;
      yield* readNow(shell).pipe(
        Effect.timeout(WORKSPACE_READ_DEADLINE),
        Effect.flatMap((probed) =>
          Effect.map(Clock.currentTimeMillis, (at) => {
            if (current()) remember(reads, shell.id, { at, place: placeOf(shell), probed });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logInfo("A mission member's checkouts were not read", cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (current()) reading.delete(shell.id);
          }),
        ),
        Effect.forkIn(background),
      );
    }
    return read === undefined ? ("pending" as const) : workspaceOf(read.probed, shell, !fresh);
  });

  const forget = (threadId: ThreadId) =>
    Effect.sync(() => {
      reads.delete(threadId);
      reading.delete(threadId);
    });

  return MemberWorkspaces.of({ cached, forget });
});

export const layer = Layer.effect(MemberWorkspaces, make);
