import {
  CommandId,
  MissionError,
  missionTag,
  missionTagOf,
  missionWasTag,
  MISSION_TAG_PREFIX,
  MISSION_WAS_TAG_PREFIX,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** `undo` takes back a join that the lead could not record, without marking a release. */
export const MissionTagChangeKind = Schema.Literals(["join", "leave", "undo"]);
export interface MissionTagChange {
  readonly kind: typeof MissionTagChangeKind.Type;
  readonly missionId: string;
  readonly name: string;
}

type MissionTagPlan =
  | { readonly refused: string }
  | { readonly remove: ReadonlyArray<string>; readonly add: ReadonlyArray<string> };

/**
 * The tag edits that move a thread into or out of a Mission. Joining is refused while the thread
 * carries another Mission's tag: the tag is a label the member's machine checks, not a lock.
 */
export const planMissionTags = (
  tags: ReadonlyArray<string>,
  change: MissionTagChange,
): MissionTagPlan => {
  const own = `${MISSION_TAG_PREFIX}${change.missionId}:`;
  const ownWas = `${MISSION_WAS_TAG_PREFIX}${change.missionId}:`;
  if (change.kind === "join") {
    const other = missionTagOf(tags.filter((tag) => !tag.startsWith(own)));
    if (other !== undefined) {
      return {
        refused: `This thread is already in another mission (tag "${other}"). Release it from that mission first.`,
      };
    }
    return {
      remove: tags.filter((tag) => tag.startsWith(ownWas)),
      add: tags.some((tag) => tag.startsWith(own))
        ? []
        : [missionTag(change.missionId, change.name)],
    };
  }
  const ownTags = tags.filter((tag) => tag.startsWith(own));
  if (change.kind === "undo") return { remove: ownTags, add: [] };
  const was = missionWasTag(change.missionId, change.name);
  return {
    remove: ownTags,
    add: tags.includes(was) ? [] : [was],
  };
};

// Joins from two leads must not both pass the check that reads the thread's tags.
const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
const lockFor = (threadId: ThreadId) => {
  const existing = threadLocks.get(threadId);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  threadLocks.set(threadId, created);
  return created;
};

/** Applies a Mission tag change to a thread on this machine, one change per thread at a time. */
export const applyMissionTags = Effect.fn("MissionTags.apply")(
  function* (threadId: ThreadId, change: MissionTagChange) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const random = yield* SecureRandom.SecureRandom;
    const fail = (message: string, reason?: MissionError["reason"]) =>
      Effect.fail(new MissionError({ message, ...(reason === undefined ? {} : { reason }) }));
    const readTags = threads.getThreadShell(threadId).pipe(
      Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? fail("That thread was not found.", "thread-gone")
          : Effect.succeed(shell.tags ?? []),
      ),
    );
    const write = (edits: ReadonlyArray<{ readonly tag: string; readonly tagged: boolean }>) =>
      Effect.forEach(edits, (edit) =>
        random.uuidV4().pipe(
          Effect.orDie,
          Effect.flatMap((id) =>
            threads.dispatch({
              type: "thread.tag.set",
              commandId: CommandId.make(`server:mission-tag:${id}`),
              threadId,
              tag: edit.tag,
              tagged: edit.tagged,
            }),
          ),
          Effect.catch((error) => fail(`The thread's tag was not changed: ${error.message}`)),
        ),
      );
    const plan = planMissionTags(yield* readTags, change);
    if ("refused" in plan) return yield* fail(plan.refused);
    yield* write([
      ...plan.remove.map((tag) => ({ tag, tagged: false })),
      ...plan.add.map((tag) => ({ tag, tagged: true })),
    ]);
    if (change.kind !== "join") return;
    // A tag written outside this lock, by hand or by an older build, still wins over this join.
    const after = planMissionTags(yield* readTags, change);
    if ("refused" in after) {
      yield* write(plan.add.map((tag) => ({ tag, tagged: false })));
      return yield* fail(after.refused);
    }
  },
  (effect, threadId) => lockFor(threadId).withPermits(1)(effect),
);
