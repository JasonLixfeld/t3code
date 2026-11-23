import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { missionTag, ThreadId, ThreadTag } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MissionClaims from "./MissionClaims.ts";
import * as MissionStore from "./MissionStore.ts";

const threadId = ThreadId.make("thread:member");

/** One machine's claims over one thread, whose tags `failTags` can stop being written. */
const onMachine = <A, E>(
  use: (
    claims: MissionClaims.MissionClaims["Service"],
    machine: { readonly tags: Array<string>; failTags: boolean },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claims-" });
    const machine = { tags: [] as Array<string>, failTags: false };
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(
              () =>
                (id === threadId
                  ? { id, deletedAt: null, tags: [...machine.tags] }
                  : null) as never,
            ),
          ),
        ),
      dispatch: (command) =>
        Effect.suspend(() => {
          if (command.type !== "thread.tag.set") throw new Error(`unexpected ${command.type}`);
          if (machine.failTags) return Effect.fail(new Error("disk full") as never);
          if (command.tagged) machine.tags.push(command.tag);
          else machine.tags.splice(machine.tags.indexOf(command.tag), 1);
          return Effect.succeed({} as never);
        }),
    });
    const context = yield* Layer.build(
      MissionClaims.layer.pipe(
        Layer.provide(MissionStore.layerFromPath(path.join(directory, "missions.sqlite"))),
        Layer.provide(Layer.merge(threads, NodeCrypto.layer)),
      ),
    );
    return yield* use(Context.get(context, MissionClaims.MissionClaims), machine);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const join = (missionId: string) => ({ threadId, missionId, name: missionId.toUpperCase() });

it.effect("two leads joining one thread at once leave it in exactly one mission", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      const [a, b] = yield* Effect.forEach(
        [
          ["link:a", "aaaa"],
          ["link:b", "bbbb"],
        ] as const,
        ([owner, missionId]) => claims.join(owner, join(missionId)).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.deepEqual([a!._tag, b!._tag].sort(), ["Failure", "Success"]);
      assert.equal(machine.tags.length, 1);
    }),
  ),
);

it.effect("joining again for the same mission and lead returns the claim it already made", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      const first = yield* claims.join("link:a", join("aaaa"));
      const again = yield* claims.join("link:a", join("aaaa"));
      assert.equal(again.claimId, first.claimId);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
    }),
  ),
);

it.effect("only the lead that holds a claim can release it, and only for its mission", () =>
  onMachine((claims) =>
    Effect.gen(function* () {
      const claim = yield* claims.join("link:a", join("aaaa"));
      const stranger = yield* claims
        .leave("link:b", { threadId, missionId: "aaaa" })
        .pipe(Effect.flip);
      assert.equal(stranger.message, "Only the mission that holds this thread can release it.");
      yield* claims.undo("link:b", { threadId, claimId: claim.claimId }).pipe(Effect.flip);
      yield* claims.leave("link:a", { threadId, missionId: "bbbb" }).pipe(Effect.flip);
      assert.deepEqual(
        (yield* claims.list("link:a")).map((held) => held.claimId),
        [claim.claimId],
      );
    }),
  ),
);

it.effect("undo takes back only the claim its own join made", () =>
  onMachine((claims) =>
    Effect.gen(function* () {
      const first = yield* claims.join("link:a", join("aaaa"));
      yield* claims.leave("link:a", { threadId, missionId: "aaaa" });
      const second = yield* claims.join("link:a", join("aaaa"));
      yield* claims.undo("link:a", { threadId, claimId: first.claimId }).pipe(Effect.flip);
      assert.deepEqual(
        (yield* claims.list("link:a")).map((held) => held.claimId),
        [second.claimId],
      );
      yield* claims.undo("link:a", { threadId, claimId: second.claimId });
      assert.deepEqual(yield* claims.list("link:a"), []);
    }),
  ),
);

it.effect("a tag that fails to write leaves the claim, and listing writes it again", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      machine.failTags = true;
      yield* claims.join("link:a", join("aaaa"));
      assert.deepEqual(machine.tags, []);
      machine.failTags = false;
      assert.equal((yield* claims.list("link:a")).length, 1);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);

      yield* claims.leave("link:a", { threadId, missionId: "aaaa" });
      // The release mark lands before the live tag goes.
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
    }),
  ),
);

it.effect("the local user leaves whichever mission holds a thread, as a release does", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      yield* claims.join("link:a", join("aaaa"));
      const left = yield* claims.leaveHere(threadId);
      assert.equal(left.owner, "link:a");
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
      assert.deepEqual(yield* claims.list("link:a"), []);
      const again = yield* claims.leaveHere(threadId).pipe(Effect.flip);
      assert.equal(again.message, "This thread is not in a mission.");
    }),
  ),
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
