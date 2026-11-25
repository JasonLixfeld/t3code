import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MissionStore from "./MissionStore.ts";
import * as Missions from "./Missions.ts";
import type { MemberStatus } from "./missionStatus.ts";
import * as MissionWakes from "./MissionWakes.ts";

const HERE = EnvironmentId.make("env-here");
const LAPTOP = EnvironmentId.make("env-laptop");
const lead = ThreadId.make("lead");
const first = ThreadId.make("first");
const second = ThreadId.make("second");
const MISSION = "0123456789ab";

type RemoteChange = { missionId: string; ref: ScopedThreadRef; status: MemberStatus };
interface Queues {
  events?: Queue.Queue<unknown>;
  remote?: Queue.Queue<RemoteChange>;
  /** Every message the lead was sent. */
  woke?: Queue.Queue<string>;
  /**
   * Each read of the lead, which a wake makes once it holds an update. Updates are handled one
   * at a time, so a read means every update before it was handled.
   */
  leadReads?: Queue.Queue<void>;
}

/** The lead and its members here, each with the fields a wake reads. */
const makeWorld = () => {
  const shells = new Map<ThreadId, Record<string, unknown>>(
    [lead, first, second].map((id) => [
      id,
      {
        id,
        deletedAt: null,
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
        activeRunId: null,
        status: "idle",
        pendingRuntimeRequest: null,
        hasActionableProposedPlan: false,
      },
    ]),
  );
  const queues: Queues = {};
  const world = {
    queues,
    get woke() {
      return queues.woke!;
    },
    get remote() {
      return queues.remote!;
    },
    get events() {
      return queues.events!;
    },
    leadRead: Effect.suspend(() => Queue.take(queues.leadReads!)),
    sent: [] as Array<string>,
    set: (id: ThreadId, fields: Record<string, unknown>) =>
      shells.set(id, { ...shells.get(id), ...fields }),
    /** The orchestrator writes a run of the thread. */
    run: (id: ThreadId, runId: string, status: string) =>
      Effect.suspend(() =>
        Queue.offer(queues.events!, {
          type: "run.updated",
          threadId: id,
          payload: { id: runId, status },
        }),
      ),
    /** The thread's run waits on a request. */
    ask: (id: ThreadId, requestId: string, kind: string) =>
      Effect.suspend(() =>
        Queue.offer(queues.events!, {
          type: "runtime-request.updated",
          threadId: id,
          payload: { id: requestId, kind, status: "pending" },
        }),
      ),
    layer: Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.suspend(() =>
            id === lead ? Queue.offer(queues.leadReads!, undefined) : Effect.void,
          ).pipe(Effect.andThen(Effect.sync(() => (shells.get(id) ?? null) as never))),
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type !== "message.dispatch" || command.threadId !== lead) {
              return Effect.die(`unexpected ${command.type}`);
            }
            world.sent.push(command.text);
            return Queue.offer(queues.woke!, command.text).pipe(Effect.as({} as never));
          }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.unwrap(
          Effect.sync(() => Stream.fromQueue(queues.events!)),
        ) as never,
      }),
      Layer.mock(Missions.Missions)({
        remoteChanges: Stream.unwrap(Effect.sync(() => Stream.fromQueue(queues.remote!))),
        roster: () =>
          Effect.succeed([
            {
              ref: { environmentId: HERE, threadId: first },
              machine: "this machine",
              project: "web",
              status: "idle",
              title: "",
            },
            {
              ref: { environmentId: HERE, threadId: second },
              machine: "this machine",
              project: "api",
              status: "idle",
              title: "",
            },
            {
              ref: { environmentId: LAPTOP, threadId: first },
              machine: "Laptop",
              project: "app",
              status: "idle",
              title: "",
            },
          ]),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
      NodeCrypto.layer,
    ),
  };
  return world;
};

/** Runs each session on a freshly started server, over the same missions database. */
const withWakes = (
  world: ReturnType<typeof makeWorld>,
  ...sessions: ReadonlyArray<Effect.Effect<void, never, MissionStore.MissionStore | Scope.Scope>>
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-wakes-" });
    const store = MissionStore.layerFromPath(path.join(directory, "missions.sqlite"));
    yield* Effect.gen(function* () {
      const missions = yield* MissionStore.MissionStore;
      yield* missions.createMission({
        threadId: lead,
        missionId: MISSION,
        name: "Ship",
        owner: HERE,
        generation: "g-lead",
      });
      for (const member of [first, second]) {
        yield* missions.join({
          threadId: member,
          missionId: MISSION,
          name: "Ship",
          owner: HERE,
          generation: `g-${member}`,
        });
      }
    }).pipe(Effect.provide(store), Effect.orDie);
    for (const session of sessions) {
      world.queues.events = yield* Queue.unbounded<unknown>();
      world.queues.remote = yield* Queue.unbounded<RemoteChange>();
      world.queues.woke = yield* Queue.unbounded<string>();
      world.queues.leadReads = yield* Queue.unbounded<void>();
      yield* Effect.scoped(
        Effect.provide(
          session,
          MissionWakes.layer.pipe(Layer.provideMerge(store), Layer.provide(world.layer)),
        ),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const busy = { activeRunId: "run-lead" };
const free = { activeRunId: null };
const told = (lines: ReadonlyArray<string>) =>
  [
    ...(lines.length === 1
      ? [`Mission update: ${lines[0]}`]
      : ["Mission update:", ...lines.map((line) => `- ${line}`)]),
    "For details, call t3_thread_read or t3_mission_roster.",
  ].join("\n");

it.effect(
  "each kind of member update wakes the lead, and what comes within 30 seconds waits",
  () => {
    const world = makeWorld();
    return withWakes(
      world,
      Effect.gen(function* () {
        yield* world.ask(first, "r1", "user_input");
        assert.equal(
          yield* Queue.take(world.woke),
          told(["thread first on this machine (web) is awaiting input."]),
        );
        yield* world.leadRead;
        yield* world.ask(first, "r2", "command");
        yield* world.run(second, "s1", "running");
        yield* world.run(second, "s1", "failed");
        yield* world.leadRead;
        yield* world.leadRead;
        assert.equal(yield* Queue.size(world.woke), 0);
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        assert.equal(
          yield* Queue.take(world.woke),
          told([
            "thread first on this machine (web) has a pending approval.",
            "thread second on this machine (api) failed.",
          ]),
        );
        yield* world.leadRead;
        yield* world.run(first, "f1", "completed");
        yield* world.leadRead;
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        assert.equal(
          yield* Queue.take(world.woke),
          told(["thread first on this machine (web) finished its turn and is idle."]),
        );
        assert.equal(world.sent.length, 3);
      }),
    );
  },
);

it.effect(
  "a running lead hears once it is idle, in one message, and its own runs wake nobody",
  () => {
    const world = makeWorld();
    return withWakes(
      world,
      Effect.gen(function* () {
        world.set(lead, busy);
        // The lead's send starts both members; starting work is no update.
        yield* world.run(first, "f1", "running");
        yield* world.run(second, "s1", "running");
        yield* world.run(first, "f1", "completed");
        yield* world.run(second, "s1", "completed");
        yield* world.leadRead;
        yield* world.leadRead;
        world.set(lead, free);
        yield* world.run(lead, "l1", "completed");
        assert.equal(
          yield* Queue.take(world.woke),
          told([
            "thread first on this machine (web) finished its turn and is idle.",
            "thread second on this machine (api) finished its turn and is idle.",
          ]),
        );
        // The wake's own turn runs and ends: there is nothing to tell, so the lead is not read.
        yield* world.run(lead, "l2", "running");
        yield* world.run(lead, "l2", "completed");
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        // A member answering the lead's next send is a real completion.
        yield* world.run(first, "f2", "completed");
        assert.equal(
          yield* Queue.take(world.woke),
          told(["thread first on this machine (web) finished its turn and is idle."]),
        );
        assert.equal(world.sent.length, 2);
      }),
    );
  },
);

it.effect("a settled or archived lead is not woken, and what it missed is dropped", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      for (const [parked, runId] of [
        [{ settledAt: "2026-01-02" }, "f1"],
        [{ archivedAt: "2026-01-02" }, "f2"],
      ] as const) {
        world.set(lead, parked);
        yield* world.run(first, runId, "failed");
        yield* world.leadRead;
        world.set(lead, { settledAt: null, archivedAt: null });
      }
      // The lead is back: only an update from now on reaches it.
      yield* world.run(second, "s1", "completed");
      assert.equal(
        yield* Queue.take(world.woke),
        told(["thread second on this machine (api) finished its turn and is idle."]),
      );
      assert.equal(world.sent.length, 1);
    }),
  );
});

it.effect(
  "a member on another machine wakes the lead, and an untold update outlives a restart",
  () => {
    const world = makeWorld();
    return withWakes(
      world,
      Effect.gen(function* () {
        const laptop = { environmentId: LAPTOP, threadId: first };
        yield* Queue.offer(world.remote, { missionId: MISSION, ref: laptop, status: "working" });
        yield* Queue.offer(world.remote, {
          missionId: MISSION,
          ref: laptop,
          status: "awaiting-input",
        });
        assert.equal(
          yield* Queue.take(world.woke),
          told(["thread first on Laptop (app) is awaiting input."]),
        );
        yield* world.leadRead;
        // The lead is busy when the server stops.
        world.set(lead, busy);
        yield* world.run(second, "s1", "failed");
        yield* world.leadRead;
        world.set(lead, free);
      }),
      Effect.gen(function* () {
        assert.equal(
          yield* Queue.take(world.woke),
          told(["thread second on this machine (api) failed."]),
        );
        assert.equal(world.sent.length, 2);
      }),
    );
  },
);

it.effect("a lead is not woken again within 30 seconds, nor twice for one update", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      yield* world.run(first, "f1", "completed");
      yield* Queue.take(world.woke);
      yield* world.leadRead;
      yield* world.run(first, "f2", "completed");
      yield* world.leadRead;
      // A run of the lead's own is handled after the update, so the update is held by now.
      yield* world.run(lead, "l1", "running");
      yield* world.leadRead;
      yield* TestClock.adjust(Duration.subtract(MissionWakes.WAKE_INTERVAL, Duration.millis(1)));
      assert.equal(yield* Queue.size(world.woke), 0);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Queue.take(world.woke);
      yield* world.leadRead;
      // The same ending written again is no new update.
      yield* world.run(first, "f2", "completed");
      yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
      yield* world.run(second, "s1", "failed");
      assert.equal(
        yield* Queue.take(world.woke),
        told(["thread second on this machine (api) failed."]),
      );
      assert.equal(world.sent.length, 3);
    }),
  );
});
