import {
  type EnvironmentId,
  CommandId,
  MissionError,
  missionTag,
  missionWasTag,
  MISSION_TAG_PREFIX,
  MISSION_WAS_TAG_PREFIX,
  type OrchestrationV2ThreadShell,
  threadHasMessages,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { MemberWorkspaces } from "./MemberWorkspaces.ts";
import * as MissionStore from "./MissionStore.ts";
import type { MissionClaim, MissionRecord } from "./MissionStore.ts";

export const linkOwner = (sessionId: string) => `link:${sessionId}`;

export const TAG_REPAIR_INTERVAL = Duration.minutes(1);

export type ThreadAccess<E> = (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;

const wasTagOf = (liveTag: string) => {
  const rest = liveTag.slice(MISSION_TAG_PREFIX.length);
  const split = rest.indexOf(":");
  return missionWasTag(rest.slice(0, split), rest.slice(split + 1));
};

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
  readonly intentId?: string | undefined;
  readonly ledHere?: boolean | undefined;
  readonly announce?: boolean | undefined;
}

export class MissionClaims extends Context.Service<
  MissionClaims,
  {
    readonly create: (
      owner: string,
      input: { readonly missionId: string; readonly name: string; readonly leadThreadId: ThreadId },
    ) => Effect.Effect<MissionRecord, MissionError>;
    readonly setLead: (
      owner: string,
      input: {
        readonly missionId: string;
        readonly name: string;
        readonly leadThreadId: ThreadId;
        readonly previous: ThreadId;
      },
    ) => Effect.Effect<MissionRecord, MissionError>;
    readonly deleteMission: (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
      readonly machines: ReadonlyArray<EnvironmentId>;
    }) => Effect.Effect<void, MissionError>;
    readonly join: <E = never>(
      owner: string,
      input: JoinInput,
      access?: ThreadAccess<E>,
    ) => Effect.Effect<MissionClaim | "intent-spent", MissionError | E>;
    readonly release: <E = never>(
      owner: string,
      input: {
        readonly threadId: ThreadId;
        readonly missionId: string;
        readonly generation: string;
      },
      access?: ThreadAccess<E>,
    ) => Effect.Effect<void, MissionError | E>;
    readonly rename: <E = never>(
      owner: string,
      input: { readonly missionId: string; readonly name: string },
      access?: ThreadAccess<E>,
    ) => Effect.Effect<ReadonlyArray<MissionClaim>>;
    readonly leaveHere: (
      threadId: ThreadId,
      missionId?: string,
    ) => Effect.Effect<void, MissionError>;
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
  }
>()("t3/missions/MissionClaims") {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const workspaces = yield* MemberWorkspaces;
  const locks = yield* KeyedLock.make<ThreadId>();
  // Never dispatch a tag write while holding the orchestrator's thread lock. It is not reentrant.
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  /** Call only under the mission claim lock. */
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

  const setLead = Effect.fn("MissionClaims.setLead")(function* (
    owner: string,
    input: {
      readonly missionId: string;
      readonly name: string;
      readonly leadThreadId: ThreadId;
      readonly previous: ThreadId;
    },
  ) {
    const { leadThreadId, previous } = input;
    const swap = Effect.gen(function* () {
      const mission = yield* threadCommands.withLock(
        leadThreadId,
        Effect.gen(function* () {
          const shell = yield* requireThread(leadThreadId);
          if (!threadHasMessages(shell)) {
            return yield* fail(
              "A mission needs a lead thread with messages. Send a message first.",
            );
          }
          return yield* store.setLead({
            threadId: leadThreadId,
            missionId: input.missionId,
            name: input.name,
            owner,
            generation: yield* generation,
            previous,
          });
        }),
      );
      yield* syncTags(leadThreadId);
      if (previous !== leadThreadId) yield* syncTags(previous);
      return mission;
    });
    if (previous === leadThreadId) return yield* locks.withLock(leadThreadId, swap);
    const [first, second] = [leadThreadId, previous].toSorted();
    return yield* locks.withLock(first!, locks.withLock(second!, swap));
  });

  const deleteMission = Effect.fn("MissionClaims.deleteMission")(
    function* (input: {
      readonly missionId: string;
      readonly lead: ThreadId;
      readonly machines: ReadonlyArray<EnvironmentId>;
    }) {
      yield* threadCommands.withLock(input.lead, store.deleteMission(input));
      yield* syncTags(input.lead);
    },
    (effect, input) => locks.withLock(input.lead, effect),
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
      const dropped = yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (access !== undefined) {
            const shell = yield* readThread(input.threadId);
            if (shell !== null && shell.deletedAt === null) yield* access(shell);
          }
          return yield* store.release({ ...input, owner });
        }),
      );
      if (dropped) yield* workspaces.forget(input.threadId);
      yield* syncTags(input.threadId);
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const leaveHere = Effect.fn("MissionClaims.leaveHere")(
    function* (threadId: ThreadId, missionId?: string) {
      yield* threadCommands.withLock(threadId, store.leave(threadId, missionId));
      yield* workspaces.forget(threadId);
      yield* syncTags(threadId);
    },
    (effect, threadId) => locks.withLock(threadId, effect),
  );

  const rename = Effect.fn("MissionClaims.rename")(function* <E>(
    owner: string,
    input: { readonly missionId: string; readonly name: string },
    access?: ThreadAccess<E>,
  ) {
    const stale = (yield* store.claimsOf(owner)).filter(
      (held) => held.missionId === input.missionId && held.name !== input.name,
    );
    for (const { threadId } of stale) {
      yield* locks.withLock(
        threadId,
        Effect.gen(function* () {
          const renamed = yield* threadCommands.withLock(
            threadId,
            Effect.gen(function* () {
              const read = yield* threads.getThreadShell(threadId).pipe(Effect.option);
              if (Option.isNone(read)) return false;
              const shell = read.value;
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
          if (renamed) yield* writeTags(threadId);
        }),
      );
    }
    return yield* store.claimsOf(owner);
  });

  return MissionClaims.of({
    create,
    setLead,
    deleteMission,
    join,
    release,
    rename,
    leaveHere,
    list: store.claimsOf,
  });
});

export const layer = Layer.effect(MissionClaims, make);

export const layerLive = layer.pipe(
  Layer.provideMerge(MissionStore.layer),
  // The same layer value the orchestrator is built with, so both take the one lock per thread.
  Layer.provide(ThreadCommandExecutor.layer),
);
