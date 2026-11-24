import {
  CommandId,
  MissionError,
  missionTag,
  missionWasTag,
  MISSION_TAG_PREFIX,
  MISSION_WAS_TAG_PREFIX,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MissionStore from "./MissionStore.ts";
import type { MissionClaim, MissionRecord } from "./MissionStore.ts";

export const MissionClaimKind = Schema.Literals(["join", "release", "list", "rename"]);

/**
 * Who holds a claim: this machine's environment id for a lead here, else the link session that
 * asked. A member's machine knows a linked lead only by its session, never by an id it sends.
 */
export const linkOwner = (sessionId: string) => `link:${sessionId}`;

/** How often this machine writes again the mission tags that an earlier write left behind. */
export const TAG_REPAIR_INTERVAL = Duration.minutes(1);

/**
 * Refuses a caller that may not change this thread. It runs just before the claim changes, under
 * the orchestrator's lock on the thread, so the thread's modes cannot rise in between.
 */
export type ThreadAccess<E> = (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;

const wasTagOf = (liveTag: string) => {
  const rest = liveTag.slice(MISSION_TAG_PREFIX.length);
  const split = rest.indexOf(":");
  return missionWasTag(rest.slice(0, split), rest.slice(split + 1));
};

/**
 * The edits that make a thread's tags say what its claim says: the claim's `mission:` tag, and
 * every other `mission:` tag turned into `mission-was:`. The claim's tag under an older name is
 * replaced, not kept as `mission-was:`. Adds come first, so a release marks before it unmarks.
 */
const planMissionTags = (tags: ReadonlyArray<string>, claim: MissionClaim | undefined) => {
  const ofClaim = (prefix: string) =>
    claim === undefined ? [] : tags.filter((tag) => tag.startsWith(`${prefix}${claim.missionId}:`));
  const live = claim === undefined ? undefined : missionTag(claim.missionId, claim.name);
  const renamed = ofClaim(MISSION_TAG_PREFIX).filter((tag) => tag !== live);
  const stray = tags.filter(
    (tag) => tag.startsWith(MISSION_TAG_PREFIX) && tag !== live && !renamed.includes(tag),
  );
  const add = new Set([
    ...(live === undefined || tags.includes(live) ? [] : [live]),
    ...stray.map(wasTagOf).filter((was) => !tags.includes(was)),
  ]);
  return [
    ...[...add].map((tag) => ({ tag, tagged: true })),
    ...[...renamed, ...stray, ...ofClaim(MISSION_WAS_TAG_PREFIX)].map((tag) => ({
      tag,
      tagged: false,
    })),
  ];
};

interface JoinInput {
  readonly threadId: ThreadId;
  readonly missionId: string;
  readonly name: string;
  /** Names one add on the lead, the same in every copy of its join. */
  readonly intentId?: string | undefined;
}

/**
 * The claims on threads here, which no other machine can change. Every change to a thread's
 * claim, and the tag write that follows it, runs under that thread's one lock. The tags are this
 * machine's own record of the claim, so it writes them itself, whoever asked for the change.
 */
export class MissionClaims extends Context.Service<
  MissionClaims,
  {
    /** Starts a Mission led by a thread here. Asking again with the same id and lead returns it. */
    readonly create: (
      owner: string,
      input: { readonly missionId: string; readonly name: string; readonly leadThreadId: ThreadId },
    ) => Effect.Effect<MissionRecord, MissionError>;
    /**
     * Joining again into the same Mission for the same owner returns the claim it already has.
     * `intent-spent`: the claim this add made was dropped here since, so the thread stays out.
     */
    readonly join: <E = never>(
      owner: string,
      input: JoinInput,
      access?: ThreadAccess<E>,
    ) => Effect.Effect<MissionClaim | "intent-spent", MissionError | E>;
    /** Drops the member claim that one join made, if this owner still holds it. Else a no-op. */
    readonly release: <E = never>(
      owner: string,
      input: {
        readonly threadId: ThreadId;
        readonly missionId: string;
        readonly generation: string;
      },
      access?: ThreadAccess<E>,
    ) => Effect.Effect<void, MissionError | E>;
    /**
     * Gives the owner's claims in a Mission its new name, then answers the owner's claims. Each
     * thread is renamed as a claim change, under its locks and `access`. A thread the caller may
     * no longer change keeps the old name.
     */
    readonly rename: <E = never>(
      owner: string,
      input: { readonly missionId: string; readonly name: string },
      access?: ThreadAccess<E>,
    ) => Effect.Effect<ReadonlyArray<MissionClaim>>;
    /** The local user frees a thread here from whichever Mission holds it. A lead thread stays. */
    readonly leaveHere: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /** The owner's claims here. Reads only. */
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
  }
>()("t3/missions/MissionClaims") {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const locks = yield* KeyedLock.make<ThreadId>();
  // The orchestrator's lock on a thread, which a mode change takes too. It is not reentrant, and a
  // tag write dispatches under it, so it is held only across an access check and its claim write.
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  /**
   * Call only while holding the thread's lock: it reads the claim it writes the tags for. A write
   * that fails leaves the thread unsynced, for the repair below.
   */
  const writeTags = Effect.fn("MissionClaims.writeTags")(
    function* (threadId: ThreadId) {
      const claim = yield* store.claim(threadId);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell !== null && shell.deletedAt === null) {
        for (const edit of planMissionTags(shell.tags ?? [], claim)) {
          const id = yield* random.uuidV4();
          yield* threads.dispatch({
            type: "thread.tag.set",
            commandId: CommandId.make(`server:mission-tag:${id}`),
            threadId,
            ...edit,
          });
        }
      }
      yield* store.tagsSynced(threadId);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("A mission tag was not written; this machine writes it again later", cause),
    ),
  );
  /** The caller's mode limit is dropped, because the claim change already passed its access check. */
  const syncTags = (threadId: ThreadId) =>
    writeTags(threadId).pipe(Effect.provideService(DispatchModeLimit, undefined));

  yield* Effect.sleep(TAG_REPAIR_INTERVAL).pipe(
    Effect.andThen(store.unsyncedTags),
    Effect.flatMap(
      Effect.forEach((threadId) => locks.withLock(threadId, syncTags(threadId)), { discard: true }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Mission tags were not repaired", cause)),
    Effect.forever,
    Effect.forkScoped,
  );

  const readThread = (threadId: ThreadId) =>
    threads
      .getThreadShell(threadId)
      .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));

  const requireThread = Effect.fn("MissionClaims.requireThread")(function* (threadId: ThreadId) {
    const shell = yield* readThread(threadId);
    if (shell === null || shell.deletedAt !== null)
      return yield* fail("That thread was not found.");
    return shell;
  });

  const generation = random.uuidV4().pipe(Effect.orDie);

  const create = Effect.fn("MissionClaims.create")(
    function* (
      owner: string,
      input: { readonly missionId: string; readonly name: string; readonly leadThreadId: ThreadId },
    ) {
      yield* requireThread(input.leadThreadId);
      const mission = yield* store.createMission({
        threadId: input.leadThreadId,
        missionId: input.missionId,
        name: input.name,
        owner,
        generation: yield* generation,
      });
      yield* syncTags(input.leadThreadId);
      return mission;
    },
    (effect, _owner, input) => locks.withLock(input.leadThreadId, effect),
  );

  const join = Effect.fn("MissionClaims.join")(
    function* <E>(owner: string, input: JoinInput, access?: ThreadAccess<E>) {
      const claim = yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const shell = yield* requireThread(input.threadId);
          if (access !== undefined) yield* access(shell);
          return yield* store.join({ ...input, owner, generation: yield* generation });
        }),
      );
      yield* syncTags(input.threadId);
      return claim;
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const release = Effect.fn("MissionClaims.release")(
    function* <E>(
      owner: string,
      input: {
        readonly threadId: ThreadId;
        readonly missionId: string;
        readonly generation: string;
      },
      access?: ThreadAccess<E>,
    ) {
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (access !== undefined) {
            const shell = yield* readThread(input.threadId);
            if (shell !== null && shell.deletedAt === null) yield* access(shell);
          }
          yield* store.release({ ...input, owner });
        }),
      );
      yield* syncTags(input.threadId);
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const leaveHere = Effect.fn("MissionClaims.leaveHere")(
    function* (threadId: ThreadId) {
      yield* store.leave(threadId);
      yield* syncTags(threadId);
    },
    (effect, threadId) => locks.withLock(threadId, effect),
  );

  const rename = Effect.fn("MissionClaims.rename")(function* <E>(
    owner: string,
    input: { readonly missionId: string; readonly name: string },
    access?: ThreadAccess<E>,
  ) {
    // `renameClaim` alone decides which of these the owner holds in this Mission.
    const stale = (yield* store.allClaims).filter((held) => held.name !== input.name);
    for (const { threadId } of stale) {
      yield* locks.withLock(
        threadId,
        Effect.gen(function* () {
          const renamed = yield* threadCommands.withLock(
            threadId,
            Effect.gen(function* () {
              const shell = yield* threads
                .getThreadShell(threadId)
                .pipe(Effect.orElseSucceed(() => null));
              if (access !== undefined && shell !== null && shell.deletedAt === null) {
                const allowed = yield* access(shell).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (!allowed) return false;
              }
              return yield* store.renameClaim({ ...input, threadId, owner });
            }),
          );
          // The caller's mode limit stays: the orchestrator checks it again for each tag write.
          if (renamed) yield* writeTags(threadId);
        }),
      );
    }
    return yield* store.claimsOf(owner);
  });

  return MissionClaims.of({ create, join, release, rename, leaveHere, list: store.claimsOf });
});

export const layer = Layer.effect(MissionClaims, make);

/** The one instance /mcp and the lead's own calls share: the same layer value is built once. */
export const layerLive = layer.pipe(
  Layer.provideMerge(MissionStore.layer),
  // The same layer value the orchestrator is built with, so both take the one lock per thread.
  Layer.provide(ThreadCommandExecutor.layer),
);
