import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { missionTag, ThreadId, ThreadTag } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { MemberWorkspaces } from "./MemberWorkspaces.ts";
import * as MissionClaims from "./MissionClaims.ts";
import * as MissionStore from "./MissionStore.ts";
import type { MissionClaim } from "./MissionStore.ts";

const threadId = ThreadId.make("thread:member");

interface Machine {
  readonly tags: Array<string>;
  failTags: boolean;
  /** Tag writes this refuses, while it says so. */
  refuses: (tag: string) => boolean;
  /** Runs at each read of the thread, before it is read. */
  onRead: Effect.Effect<void>;
  /** Reads of the thread fail while it says so. */
  readFails: boolean;
  /** Every tag write that landed, to wait on. */
  readonly written: Queue.Queue<string>;
  /** The orchestrator's lock on each thread, which a mode change there takes. */
  readonly threadCommands: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
  /** What happened to the thread, in order. */
  readonly events: Array<string>;
}

/** One machine's claims over one thread, whose tags `failTags` can stop being written. */
const onMachine = <A, E>(
  use: (claims: MissionClaims.MissionClaims["Service"], machine: Machine) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claims-" });
    const machine: Machine = {
      tags: [],
      failTags: false,
      refuses: () => false,
      onRead: Effect.void,
      readFails: false,
      written: yield* Queue.unbounded<string>(),
      threadCommands: yield* ThreadCommandExecutor.make,
      events: [],
    };
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.suspend(() => machine.onRead).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              machine.readFails ? Effect.fail(new Error("unreadable") as never) : Effect.void,
            ),
          ),
          Effect.andThen(Effect.yieldNow),
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
          if (machine.failTags || machine.refuses(command.tag)) {
            return Effect.fail(new Error("disk full") as never);
          }
          if (command.tagged) machine.tags.push(command.tag);
          else machine.tags.splice(machine.tags.indexOf(command.tag), 1);
          return Effect.as(Queue.offer(machine.written, command.tag), {} as never);
        }),
    });
    const store = Layer.effect(
      MissionStore.MissionStore,
      Effect.map(MissionStore.MissionStore, (real) =>
        MissionStore.MissionStore.of({
          ...real,
          join: (input) =>
            real
              .join(input)
              .pipe(Effect.tap(() => Effect.sync(() => machine.events.push("claim written")))),
        }),
      ),
    ).pipe(Layer.provide(MissionStore.layerFromPath(path.join(directory, "missions.sqlite"))));
    const context = yield* Layer.build(
      MissionClaims.layer.pipe(
        Layer.provide(store),
        Layer.provide(
          Layer.mergeAll(
            threads,
            NodeCrypto.layer,
            Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, machine.threadCommands),
            Layer.mock(MemberWorkspaces)({
              forget: (id) => Effect.sync(() => machine.events.push(`forgot ${id}`)),
            }),
          ),
        ),
      ),
    );
    return yield* use(Context.get(context, MissionClaims.MissionClaims), machine);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const join = (missionId: string) => ({ threadId, missionId, name: missionId.toUpperCase() });
/** The claim a join made, in a test where its add cannot have been spent. */
const claimOf = (joined: MissionClaim | "intent-spent") => {
  if (joined === "intent-spent") throw new Error("the add was already spent");
  return joined;
};

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
      const first = claimOf(yield* claims.join("link:a", join("aaaa")));
      const again = claimOf(yield* claims.join("link:a", join("aaaa")));
      assert.equal(again.generation, first.generation);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a release that arrives late does not drop the claim a later join made", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      const first = claimOf(yield* claims.join("link:a", join("aaaa")));
      yield* claims.leaveHere(threadId);
      const second = claimOf(yield* claims.join("link:a", join("aaaa")));
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

it.effect("leaving spends every add that stood behind the claim, and only those", () =>
  onMachine((claims) =>
    Effect.gen(function* () {
      const add = (intentId: string) => claims.join("link:a", { ...join("aaaa"), intentId });
      const first = yield* add("one");
      // A second add of the thread while it is in takes the same claim over.
      assert.deepEqual(yield* add("two"), first);
      yield* claims.leaveHere(threadId);
      assert.deepEqual([yield* add("one"), yield* add("two")], ["intent-spent", "intent-spent"]);
      // The same lead under a new link session is another owner, and its copy is as spent.
      assert.equal(
        yield* claims.join("link:b", { ...join("aaaa"), intentId: "one" }),
        "intent-spent",
      );
      assert.deepEqual(yield* claims.list("link:a"), []);
      assert.notEqual(yield* add("three"), "intent-spent");
    }),
  ),
);

it.effect("a mode change waits while a join checks its caller and writes the claim", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      // How the orchestrator changes a thread's mode: under its own lock on that thread.
      const raiseMode = machine.threadCommands.withLock(
        threadId,
        Effect.sync(() => machine.events.push("mode raised")),
      );
      const raising: Array<Fiber.Fiber<number>> = [];
      // The caller passes the check, and the user raises the mode at that very moment.
      yield* claims.join("link:a", join("aaaa"), () =>
        raiseMode.pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.map((fiber) => void raising.push(fiber)),
        ),
      );
      yield* Fiber.join(raising[0]!);
      assert.deepEqual(machine.events, ["claim written", "mode raised"]);
    }),
  ),
);

it.effect("a tag that fails to write is written again by this machine, never by a list", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      machine.failTags = true;
      yield* claims.join("link:a", join("aaaa"));
      machine.failTags = false;
      assert.equal((yield* claims.list("link:a")).length, 1);
      assert.deepEqual(machine.tags, []);
      yield* TestClock.adjust(MissionClaims.TAG_REPAIR_INTERVAL);
      yield* Queue.take(machine.written);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);

      machine.failTags = true;
      yield* claims.leaveHere(threadId);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
      machine.failTags = false;
      yield* TestClock.adjust(MissionClaims.TAG_REPAIR_INTERVAL);
      // The release mark lands before the live tag goes.
      assert.deepEqual(yield* Queue.takeN(machine.written, 2), [
        "mission-was:aaaa:AAAA",
        "mission:aaaa:AAAA",
      ]);
      assert.deepEqual(machine.tags, ["mission-was:aaaa:AAAA"]);
    }),
  ),
);

it.effect("a rename that lands while tags are written is still written once it fails", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      machine.failTags = true;
      yield* claims.join("link:a", join("aaaa"));
      machine.failTags = false;
      machine.refuses = (tag) => tag.endsWith(":Renamed");
      const renaming: Array<Fiber.Fiber<unknown>> = [];
      // The rename arrives while the repair holds the thread and has read its old name.
      machine.onRead = Effect.suspend(() => {
        machine.onRead = Effect.void;
        return claims.rename("link:a", { missionId: "aaaa", name: "Renamed" }).pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.map((fiber) => void renaming.push(fiber)),
        );
      });
      yield* TestClock.adjust(MissionClaims.TAG_REPAIR_INTERVAL);
      assert.equal(yield* Queue.take(machine.written), "mission:aaaa:AAAA");
      yield* Fiber.join(renaming[0]!);
      machine.refuses = () => false;
      yield* TestClock.adjust(MissionClaims.TAG_REPAIR_INTERVAL);
      assert.equal(yield* Queue.take(machine.written), "mission:aaaa:Renamed");
      assert.deepEqual(machine.tags, ["mission:aaaa:Renamed"]);
    }),
  ),
);

it.effect("a rename skips a thread it cannot read, leaving its name and tags as they were", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      yield* claims.join("link:a", join("aaaa"));
      machine.readFails = true;
      const answered = yield* claims.rename(
        "link:a",
        { missionId: "aaaa", name: "Renamed" },
        () => Effect.void,
      );
      machine.readFails = false;
      assert.deepEqual(
        answered.map((claim) => claim.name),
        ["AAAA"],
      );
      // Nothing is left for the repair to write either.
      yield* TestClock.adjust(MissionClaims.TAG_REPAIR_INTERVAL);
      assert.deepEqual(machine.tags, ["mission:aaaa:AAAA"]);
      assert.equal(yield* Queue.size(machine.written), 1);
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
        assert.include(refused.message, "lead cannot leave");
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

it.effect("only a release or leave that drops the claim forgets what was read of the thread", () =>
  onMachine((claims, machine) =>
    Effect.gen(function* () {
      const joined = yield* claims.join("env-lead", { threadId, missionId: "ship", name: "Ship" });
      const generation = typeof joined === "string" ? "" : joined.generation;
      yield* claims.release("env-lead", { threadId, missionId: "ship", generation });
      yield* claims.join("env-lead", { threadId, missionId: "ship", name: "Ship" });
      // A late release of the first join leaves the new claim, and what was read of it.
      yield* claims.release("env-lead", { threadId, missionId: "ship", generation });
      yield* claims.leaveHere(threadId);
      assert.deepEqual(
        machine.events.filter((event) => event.startsWith("forgot")),
        [`forgot ${threadId}`, `forgot ${threadId}`],
      );
    }),
  ),
);
