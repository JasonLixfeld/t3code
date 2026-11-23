import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { missionTag, ThreadId, ThreadTag } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { applyMissionTags } from "./MissionTags.ts";

const threadId = ThreadId.make("thread:member");

/**
 * One thread whose reads and writes each yield, as a real store does, so two changes interleave
 * unless something keeps them apart. `onTagged` runs after each tag is added.
 */
const threadWith = (tags: Array<string>, onTagged: (tag: string) => void = () => {}) =>
  Layer.merge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => ({ id: threadId, deletedAt: null, tags: [...tags] }) as never),
          ),
        ),
      dispatch: (command) =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (command.type !== "thread.tag.set") throw new Error(`unexpected ${command.type}`);
              if (command.tagged) {
                tags.push(command.tag);
                onTagged(command.tag);
              } else {
                tags.splice(tags.indexOf(command.tag), 1);
              }
              return {} as never;
            }),
          ),
        ),
    }),
    NodeCrypto.layer,
  );

it.effect("two joins for different missions at once leave the thread in exactly one", () => {
  const tags: Array<string> = [];
  return Effect.gen(function* () {
    const [a, b] = yield* Effect.forEach(
      [
        { kind: "join", missionId: "aaaa", name: "A" },
        { kind: "join", missionId: "bbbb", name: "B" },
      ] as const,
      (change) => applyMissionTags(threadId, change).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.deepEqual([a!._tag, b!._tag].sort(), ["Failure", "Success"]);
    assert.equal(tags.length, 1);
  }).pipe(Effect.provide(threadWith(tags)));
});

it.effect(
  "a mission tag written outside the lock during a join wins, and the join takes its own back",
  () => {
    const tags: Array<string> = [];
    const foreign = "mission:cccc:Written by hand";
    return Effect.gen(function* () {
      const refused = yield* applyMissionTags(threadId, {
        kind: "join",
        missionId: "aaaa",
        name: "A",
      }).pipe(Effect.flip);
      assert.include(refused.message, "already in another mission");
      assert.deepEqual(tags, [foreign]);
    }).pipe(
      Effect.provide(
        threadWith(tags, (tag) => {
          if (tag !== foreign) tags.push(foreign);
        }),
      ),
    );
  },
);

const isTag = Schema.is(ThreadTag);

it.each([
  ["an emoji across the limit", "a".repeat(42) + "😀"],
  ["an emoji just inside the limit", "a".repeat(41) + "😀"],
  ["a flag of two code points", "a".repeat(41) + "🇨🇦"],
  ["only emoji", "😀".repeat(40)],
])("cuts %s into a well-formed tag the tag schema accepts", (_name, name) => {
  const tag = missionTag("0123456789ab", name);
  assert.isTrue(tag.isWellFormed(), tag);
  assert.isAtMost(tag.length, 64);
  assert.isTrue(isTag(tag));
  assert.isTrue(`mission:0123456789ab:${name}`.startsWith(tag));
});
