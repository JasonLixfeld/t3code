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

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const MissionTagChangeKind = Schema.Literals(["join", "leave"]);
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
  const was = missionWasTag(change.missionId, change.name);
  return {
    remove: tags.filter((tag) => tag.startsWith(own)),
    add: tags.includes(was) ? [] : [was],
  };
};

/** Applies a Mission tag change to a thread on this machine. */
export const applyMissionTags = Effect.fn("MissionTags.apply")(function* (
  threadId: ThreadId,
  change: MissionTagChange,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const fail = (message: string) => Effect.fail(new MissionError({ message }));
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.catch((error) => fail(`The thread could not be read: ${error.message}`)));
  if (shell === null || shell.deletedAt !== null) return yield* fail("That thread was not found.");
  const plan = planMissionTags(shell.tags ?? [], change);
  if ("refused" in plan) return yield* fail(plan.refused);
  const edits = [
    ...plan.remove.map((tag) => ({ tag, tagged: false })),
    ...plan.add.map((tag) => ({ tag, tagged: true })),
  ];
  for (const edit of edits) {
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    yield* threads
      .dispatch({
        type: "thread.tag.set",
        commandId: CommandId.make(`server:mission-tag:${id}`),
        threadId,
        tag: edit.tag,
        tagged: edit.tagged,
      })
      .pipe(Effect.catch((error) => fail(`The thread's tag was not changed: ${error.message}`)));
  }
});
