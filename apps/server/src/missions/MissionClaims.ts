import {
  CommandId,
  MissionError,
  missionTag,
  missionWasTag,
  MISSION_TAG_PREFIX,
  MISSION_WAS_TAG_PREFIX,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MissionStore from "./MissionStore.ts";
import type { MissionClaim, MissionRecord } from "./MissionStore.ts";

export const MissionClaimKind = Schema.Literals(["join", "release", "list"]);

/**
 * Who holds a claim: this machine's environment id for a lead here, else the link session that
 * asked. A member's machine knows a linked lead only by its session, never by an id it sends.
 */
export const linkOwner = (sessionId: string) => `link:${sessionId}`;

const wasTagOf = (liveTag: string) => {
  const rest = liveTag.slice(MISSION_TAG_PREFIX.length);
  const split = rest.indexOf(":");
  return missionWasTag(rest.slice(0, split), rest.slice(split + 1));
};

/**
 * The edits that make a thread's tags say what its claim says: the claim's `mission:` tag, and
 * every other `mission:` tag turned into `mission-was:`. Adds come first, so a release marks
 * before it unmarks.
 */
const planMissionTags = (tags: ReadonlyArray<string>, claim: MissionClaim | undefined) => {
  const ofClaim = (prefix: string) =>
    claim === undefined ? [] : tags.filter((tag) => tag.startsWith(`${prefix}${claim.missionId}:`));
  const live = ofClaim(MISSION_TAG_PREFIX);
  const stray = tags.filter((tag) => tag.startsWith(MISSION_TAG_PREFIX) && !live.includes(tag));
  const add = new Set([
    ...(claim === undefined || live.length > 0 ? [] : [missionTag(claim.missionId, claim.name)]),
    ...stray.map(wasTagOf).filter((was) => !tags.includes(was)),
  ]);
  return [
    ...[...add].map((tag) => ({ tag, tagged: true })),
    ...[...stray, ...ofClaim(MISSION_WAS_TAG_PREFIX)].map((tag) => ({ tag, tagged: false })),
  ];
};

/**
 * The claims on threads here, which no other machine can change. Every change to a thread's
 * claim, and the tag write that follows it, runs under that thread's one lock.
 */
export class MissionClaims extends Context.Service<
  MissionClaims,
  {
    /** Starts a Mission led by a thread here. Asking again with the same id and lead returns it. */
    readonly create: (
      owner: string,
      input: { readonly missionId: string; readonly name: string; readonly leadThreadId: ThreadId },
    ) => Effect.Effect<MissionRecord, MissionError>;
    /** Joining again into the same Mission for the same owner returns the claim it already has. */
    readonly join: (
      owner: string,
      input: { readonly threadId: ThreadId; readonly missionId: string; readonly name: string },
    ) => Effect.Effect<MissionClaim, MissionError>;
    /** Drops the member claim that one join made, if this owner still holds it. Else a no-op. */
    readonly release: (
      owner: string,
      input: {
        readonly threadId: ThreadId;
        readonly missionId: string;
        readonly generation: string;
      },
    ) => Effect.Effect<void>;
    /** The local user frees a thread here from whichever Mission holds it. A lead thread stays. */
    readonly leaveHere: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /**
     * The owner's claims here. Writes the tags of those threads again, and of every thread whose
     * tags a failed write left behind its claim.
     */
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
  }
>()("t3/missions/MissionClaims") {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const locks = yield* KeyedLock.make<ThreadId>();

  /** Call only while holding the thread's lock: it reads the claim it writes the tags for. */
  const syncTags = Effect.fn("MissionClaims.syncTags")(
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
      Effect.logWarning("A mission tag was not written; the next list writes it", cause),
    ),
  );

  const requireThread = Effect.fn("MissionClaims.requireThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));
    if (shell === null || shell.deletedAt !== null)
      return yield* fail("That thread was not found.");
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
    function* (
      owner: string,
      input: { readonly threadId: ThreadId; readonly missionId: string; readonly name: string },
    ) {
      yield* requireThread(input.threadId);
      const claim = yield* store.join({ ...input, owner, generation: yield* generation });
      yield* syncTags(input.threadId);
      return claim;
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const release = Effect.fn("MissionClaims.release")(
    function* (
      owner: string,
      input: {
        readonly threadId: ThreadId;
        readonly missionId: string;
        readonly generation: string;
      },
    ) {
      yield* store.release({ ...input, owner });
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

  const list = Effect.fn("MissionClaims.list")(function* (owner: string) {
    const threadIds = new Set([
      ...(yield* store.claimsOf(owner)).map((claim) => claim.threadId),
      ...(yield* store.unsyncedTags),
    ]);
    yield* Effect.forEach(threadIds, (threadId) => locks.withLock(threadId, syncTags(threadId)), {
      discard: true,
    });
    return yield* store.claimsOf(owner);
  });

  return MissionClaims.of({ create, join, release, leaveHere, list });
});

export const layer = Layer.effect(MissionClaims, make);

/** The one instance /mcp and the lead's own calls share: the same layer value is built once. */
export const layerLive = layer.pipe(Layer.provideMerge(MissionStore.layer));
