import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type MissionError, missionTag, ThreadId, ThreadTag } from "@t3tools/contracts";
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

interface Machine {
  readonly tags: Array<string>;
  failTags: boolean;
  /** Runs once, right after `list` has read the owner's claims and before it takes a lock. */
  afterClaimsRead: Effect.Effect<void, MissionError>;
}

/** One machine's claims over one thread, whose tags `failTags` can stop being written. */
const onMachine = <A, E>(
  use: (claims: MissionClaims.MissionClaims["Service"], machine: Machine) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claims-" });
    const machine: Machine = { tags: [], failTags: false, afterClaimsRead: Effect.void };
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
    const store = Layer.effect(
      MissionStore.MissionStore,
      Effect.map(MissionStore.MissionStore, (real) =>
        MissionStore.MissionStore.of({
          ...real,
          claimsOf: (owner) =>
            real.claimsOf(owner).pipe(
              Effect.tap(() => {
                const landing = machine.afterClaimsRead;
                machine.afterClaimsRead = Effect.void;
                return Effect.ignore(landing);
              }),
            ),
        }),
      ),
    ).pipe(Layer.provide(MissionStore.layerFromPath(path.join(directory, "missions.sqlite"))));
    const context = yield* Layer.build(
      MissionClaims.layer.pipe(
        Layer.provide(store),
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
      assert.equal(again.generation, first.generation);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a release that arrives late does not drop the claim a later join made", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      const first = yield* claims.join("link:a", join("aaaa"));
      yield* claims.leaveHere(threadId);
      const second = yield* claims.join("link:a", join("aaaa"));
      yield* claims.release("link:a", {
        threadId,
        missionId: "aaaa",
        generation: first.generation,
      });
      yield* claims.release("link:b", {
        threadId,
        missionId: "aaaa",
        generation: second.generation,
      });
      assert.deepEqual(yield* claims.list("link:a"), [second]);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);

      yield* claims.release("link:a", {
        threadId,
        missionId: "aaaa",
        generation: second.generation,
      });
      assert.deepEqual(yield* claims.list("link:a"), []);
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a leave that lands after list read the claims is not undone by list", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      yield* claims.join("link:a", join("aaaa"));
      machine.afterClaimsRead = claims.leaveHere(threadId);
      assert.deepEqual(yield* claims.list("link:a"), []);
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a tag that fails to write is written by the next list, whoever asks", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      machine.failTags = true;
      yield* claims.join("link:a", join("aaaa"));
      assert.deepEqual(machine.tags, []);
      machine.failTags = false;
      assert.deepEqual(yield* claims.list("link:b"), []);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);

      machine.failTags = true;
      yield* claims.leaveHere(threadId);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
      machine.failTags = false;
      yield* claims.list("link:b");
      // The release mark lands before the live tag goes.
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a leave racing the start of a mission never frees its lead", () =>
  Effect.forEach([false, true], (leaveFirst) =>
    onMachine((claims, machine) =>
      Effect.gen(function* () {
        const racers = [
          claims.create("env-here", { missionId: "aaaa", name: "AAAA", leadThreadId: threadId }),
          claims.leaveHere(threadId),
        ];
        yield* Effect.forEach(leaveFirst ? racers.toReversed() : racers, Effect.result, {
          concurrency: "unbounded",
        });
        const refused = yield* claims.leaveHere(threadId).pipe(Effect.flip);
        assert.include(refused.message, "lead cannot be released");
        assert.equal((yield* claims.list("env-here"))[0]?.role, "lead");
        assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
      }),
    ),
  ),
);

it.effect("the local user leaves whichever mission holds a thread, as a release does", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      yield* claims.join("link:a", join("aaaa"));
      yield* claims.leaveHere(threadId);
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
