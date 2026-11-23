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
import type { MissionClaim } from "./MissionStore.ts";

export const MissionClaimKind = Schema.Literals(["join", "leave", "undo", "list"]);

/**
 * Who holds a claim: this machine's environment id for a lead here, else the link session that
 * asked. A member's machine knows a linked lead only by its session, never by an id it sends.
 */
export const linkOwner = (sessionId: string) => `link:${sessionId}`;

type TagChange = {
  readonly kind: "join" | "leave" | "undo";
  readonly missionId: string;
  readonly name: string;
};

/** The tag edits that mirror a claim change. Adds come first, so a release marks before it unmarks. */
const planMissionTags = (tags: ReadonlyArray<string>, change: TagChange) => {
  const live = tags.filter((tag) => tag.startsWith(`${MISSION_TAG_PREFIX}${change.missionId}:`));
  const was = missionWasTag(change.missionId, change.name);
  switch (change.kind) {
    case "join":
      return {
        add: live.length > 0 ? [] : [missionTag(change.missionId, change.name)],
        remove: tags.filter((tag) =>
          tag.startsWith(`${MISSION_WAS_TAG_PREFIX}${change.missionId}:`),
        ),
      };
    case "leave":
      return { add: tags.includes(was) ? [] : [was], remove: live };
    case "undo":
      return { add: [], remove: live };
  }
};

/** The member's side: the claims on threads here, which no other machine can change. */
export class MissionClaims extends Context.Service<
  MissionClaims,
  {
    /** Joining again into the same Mission for the same owner returns the claim it already has. */
    readonly join: (
      owner: string,
      input: { readonly threadId: ThreadId; readonly missionId: string; readonly name: string },
    ) => Effect.Effect<MissionClaim, MissionError>;
    /** Succeeds when no claim is left; refuses a claim another owner or Mission holds. */
    readonly leave: (
      owner: string,
      input: { readonly threadId: ThreadId; readonly missionId: string },
    ) => Effect.Effect<void, MissionError>;
    /** Takes back only the claim that one join made. */
    readonly undo: (
      owner: string,
      input: { readonly threadId: ThreadId; readonly claimId: string },
    ) => Effect.Effect<void, MissionError>;
    /** The owner's claims here, with each thread's tag written again. */
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<MissionClaim>>;
  }
>()("t3/missions/MissionClaims") {}

const fail = (message: string) => Effect.fail(new MissionError({ message }));

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const locks = yield* KeyedLock.make<ThreadId>();

  // A failed tag write leaves the claim right; the next `list` writes the live tag again.
  const mirror = Effect.fn("MissionClaims.mirror")(
    function* (threadId: ThreadId, change: TagChange) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return;
      const plan = planMissionTags(shell.tags ?? [], change);
      const edits = [
        ...plan.add.map((tag) => ({ tag, tagged: true })),
        ...plan.remove.map((tag) => ({ tag, tagged: false })),
      ];
      for (const edit of edits) {
        const id = yield* random.uuidV4();
        yield* threads.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`server:mission-tag:${id}`),
          threadId,
          tag: edit.tag,
          tagged: edit.tagged,
        });
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("A mission tag was not written", cause)),
  );

  const join = Effect.fn("MissionClaims.join")(
    function* (
      owner: string,
      input: { readonly threadId: ThreadId; readonly missionId: string; readonly name: string },
    ) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));
      if (shell === null || shell.deletedAt !== null)
        return yield* fail("That thread was not found.");
      const claimId = yield* random.uuidV4().pipe(Effect.orDie);
      const held = yield* store.claim({ ...input, owner, claimId });
      if (held.owner !== owner || held.claim.missionId !== input.missionId) {
        return yield* fail(
          `This thread is already in another mission ("${held.claim.name}"). Release it from that mission first.`,
        );
      }
      yield* mirror(input.threadId, { kind: "join", ...input });
      return held.claim;
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const notYours = "Only the mission that holds this thread can release it.";

  const leave = Effect.fn("MissionClaims.leave")(
    function* (owner: string, input: { readonly threadId: ThreadId; readonly missionId: string }) {
      const dropped = yield* store.dropClaim(input.threadId, { owner, missionId: input.missionId });
      if (dropped === "not-yours") return yield* fail(notYours);
      if (dropped !== "absent") yield* mirror(input.threadId, { kind: "leave", ...dropped });
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const undo = Effect.fn("MissionClaims.undo")(
    function* (owner: string, input: { readonly threadId: ThreadId; readonly claimId: string }) {
      const dropped = yield* store.dropClaim(input.threadId, { owner, claimId: input.claimId });
      if (dropped === "not-yours") return yield* fail(notYours);
      if (dropped !== "absent") yield* mirror(input.threadId, { kind: "undo", ...dropped });
    },
    (effect, _owner, input) => locks.withLock(input.threadId, effect),
  );

  const list = Effect.fn("MissionClaims.list")(function* (owner: string) {
    const claims = yield* store.claimsOf(owner);
    yield* Effect.forEach(claims, (claim) =>
      locks.withLock(claim.threadId, mirror(claim.threadId, { kind: "join", ...claim })),
    );
    return claims;
  });

  return MissionClaims.of({ join, leave, undo, list });
});

export const layer = Layer.effect(MissionClaims, make);

/** The one instance /mcp and the lead's own calls share: the same layer value is built once. */
export const layerLive = layer.pipe(Layer.provideMerge(MissionStore.layer));
