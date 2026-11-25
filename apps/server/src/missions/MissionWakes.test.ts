import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MissionStore from "./MissionStore.ts";
import * as Missions from "./Missions.ts";
import type { MemberDetail } from "./missionStatus.ts";
import * as MissionWakes from "./MissionWakes.ts";

const HERE = EnvironmentId.make("env-here");
const LAPTOP = EnvironmentId.make("env-laptop");
const lead = ThreadId.make("lead");
const first = ThreadId.make("first");
const second = ThreadId.make("second");
const MISSION = "0123456789ab";

type RemoteChange = { missionId: string; ref: ScopedThreadRef; detail: MemberDetail };
interface Sent {
  readonly threadId: ThreadId;
  /** The Mission's lead when the orchestrator took the wake. */
  readonly leadNow: ThreadId | undefined;
  readonly commandId: string;
  readonly text: string;
}
/** Made again for each start of the server. */
interface Session {
  events?: Queue.Queue<unknown>;
  remote?: Queue.Queue<RemoteChange>;
  leadChanges?: Queue.Queue<string>;
  /** Every message a lead was sent, and how. */
  woke?: Queue.Queue<Sent>;
  /**
   * Each read of a lead, which a wake makes once it holds an update. Updates are handled one at a
   * time, so a read means every update before it was handled.
   */
  leadReads?: Queue.Queue<ThreadId>;
  /** The lock the wake and a lead change share, as Missions holds it. */
  lock?: Semaphore.Semaphore;
  store?: MissionStore.MissionStore["Service"];
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
      },
    ]),
  );
  const session: Session = {};
  const sent: Array<Sent> = [];
  const hooks: {
    afterDispatch: () => Effect.Effect<void>;
    onLeadRead: (id: ThreadId) => Effect.Effect<void>;
    afterLeadRead: (id: ThreadId) => Effect.Effect<void>;
  } = {
    afterDispatch: () => Effect.void,
    onLeadRead: () => Effect.void,
    afterLeadRead: () => Effect.void,
  };
  const parkedNow = (id: ThreadId) => {
    const shell = shells.get(id)!;
    return shell.settledAt !== null || shell.archivedAt !== null;
  };
  const world = {
    session,
    get woke() {
      return session.woke!;
    },
    leadRead: Effect.suspend(() => Queue.take(session.leadReads!)),
    /** What the orchestrator took, once per command id as its receipts keep it. */
    sent,
    /**
     * `afterDispatch` runs inside a dispatch, after the orchestrator took it, as a stop just after
     * the commit would. `onLeadRead` runs on a lead read before it reads, `afterLeadRead` after.
     */
    hooks,
    set: (id: ThreadId, fields: Record<string, unknown>) =>
      shells.set(id, { ...shells.get(id), ...fields }),
    /** The orchestrator writes a run of the thread. */
    run: (id: ThreadId, runId: string, status: string) =>
      Effect.suspend(() =>
        Queue.offer(session.events!, {
          type: "run.updated",
          threadId: id,
          payload: { id: runId, status },
        }),
      ),
    /** The thread's run waits on a request. */
    ask: (id: ThreadId, requestId: string, kind: string) =>
      Effect.suspend(() =>
        Queue.offer(session.events!, {
          type: "runtime-request.updated",
          threadId: id,
          payload: { id: requestId, kind, status: "pending" },
        }),
      ),
    /** The thread's agent asks the user for a secret, in a card it waits on. */
    secretCard: (id: ThreadId, cardId: string) =>
      Effect.suspend(() =>
        Queue.offer(session.events!, {
          type: "turn-item.updated",
          threadId: id,
          payload: { id: cardId, type: "secret_request", status: "waiting", nodeId: "node-1" },
        }),
      ),
    listed: (ref: ScopedThreadRef, detail: Partial<MemberDetail>) =>
      Effect.suspend(() =>
        Queue.offer(session.remote!, {
          missionId: MISSION,
          ref,
          detail: { status: "idle", title: "", project: "", requests: [], ...detail },
        }),
      ),
    /**
     * The user makes `next` the lead, as Missions does: under the wake's lock, then says so. With
     * `ifFree`, only when nothing holds that lock now, and answers whether it did.
     */
    setLead: (next: ThreadId, previous: ThreadId, ifFree = false) =>
      Effect.gen(function* () {
        const write = session.store!.setLead({
          threadId: next,
          missionId: MISSION,
          name: "Ship",
          owner: HERE,
          generation: `g-lead-${next}`,
          previous,
        });
        const done = ifFree
          ? Option.isSome(yield* session.lock!.withPermitsIfAvailable(1)(write))
          : (yield* session.lock!.withPermits(1)(write), true);
        if (done) yield* Queue.offer(session.leadChanges!, MISSION);
        return done;
      }).pipe(Effect.orDie),
    missions: Layer.effect(
      Missions.Missions,
      Effect.gen(function* () {
        const store = yield* MissionStore.MissionStore;
        session.store = store;
        session.lock = yield* Semaphore.make(1);
        return Missions.Missions.of({
          remoteChanges: Stream.unwrap(Effect.sync(() => Stream.fromQueue(session.remote!))),
          leadChanges: Stream.unwrap(Effect.sync(() => Stream.fromQueue(session.leadChanges!))),
          withLead: (
            missionId: string,
            use: (mission: MissionStore.MissionRecord) => Effect.Effect<unknown>,
          ) =>
            session.lock!.withPermits(1)(
              Effect.flatMap(store.missions, (all) => {
                const mission = all.find((candidate) => candidate.missionId === missionId);
                return mission === undefined ? Effect.undefined : use(mission);
              }),
            ),
        } as never);
      }),
    ),
    layer: Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.gen(function* () {
            if (id !== lead && id !== second) return (shells.get(id) ?? null) as never;
            yield* hooks.onLeadRead(id);
            const shell = { ...shells.get(id) };
            yield* hooks.afterLeadRead(id);
            yield* Queue.offer(session.leadReads!, id);
            return shell as never;
          }),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type !== "message.dispatch") return yield* Effect.die(command.type);
            // As the orchestrator: a command id it took before is a replay, and a parked lead
            // is left as it is when the wake asks so.
            const replay = sent.some((taken) => taken.commandId === command.commandId);
            if (!replay && !(command.unlessParked === true && parkedNow(command.threadId))) {
              const missions = yield* session.store!.missions;
              const taken = {
                threadId: command.threadId,
                leadNow: missions.find((mission) => mission.missionId === MISSION)?.leadThreadId,
                commandId: command.commandId,
                text: command.text,
              };
              sent.push(taken);
              yield* Queue.offer(session.woke!, taken);
            }
            yield* hooks.afterDispatch();
            return {} as never;
          }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.unwrap(
          Effect.sync(() => Stream.fromQueue(session.events!)),
        ) as never,
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
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
      world.session.events = yield* Queue.unbounded<unknown>();
      world.session.remote = yield* Queue.unbounded<RemoteChange>();
      world.session.leadChanges = yield* Queue.unbounded<string>();
      world.session.woke = yield* Queue.unbounded<Sent>();
      world.session.leadReads = yield* Queue.unbounded<ThreadId>();
      yield* Effect.scoped(
        Effect.provide(
          session,
          MissionWakes.layer.pipe(
            Layer.provideMerge(world.missions),
            Layer.provideMerge(store),
            Layer.provide(world.layer),
          ),
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
const nextText = (world: ReturnType<typeof makeWorld>) =>
  Queue.take(world.woke).pipe(Effect.map((sent) => sent.text));

it.effect(
  "each kind of member update wakes the lead, and what comes within 30 seconds waits",
  () => {
    const world = makeWorld();
    return withWakes(
      world,
      Effect.gen(function* () {
        yield* world.ask(first, "r1", "user_input");
        assert.equal(
          yield* nextText(world),
          told(["thread first on this machine is awaiting input."]),
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
          yield* nextText(world),
          told([
            "thread first on this machine has a pending approval.",
            "thread second on this machine failed.",
          ]),
        );
        yield* world.leadRead;
        yield* world.run(first, "f1", "completed");
        yield* world.leadRead;
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        assert.equal(
          yield* nextText(world),
          told(["thread first on this machine finished its turn and is idle."]),
        );
        assert.equal(world.sent.length, 3);
      }),
    );
  },
);

it.effect("a member's secret request card wakes the lead, as the card blocks on the user", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      yield* world.secretCard(first, "card-1");
      assert.equal(
        yield* nextText(world),
        told(["thread first on this machine is awaiting input."]),
      );
    }),
  );
});

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
          yield* nextText(world),
          told([
            "thread first on this machine finished its turn and is idle.",
            "thread second on this machine finished its turn and is idle.",
          ]),
        );
        // The wake's own turn runs and ends: there is nothing to tell, so the lead is not read.
        yield* world.run(lead, "l2", "running");
        yield* world.run(lead, "l2", "completed");
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        // A member answering the lead's next send is a real completion.
        yield* world.run(first, "f2", "completed");
        assert.equal(
          yield* nextText(world),
          told(["thread first on this machine finished its turn and is idle."]),
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
        yield* nextText(world),
        told(["thread second on this machine finished its turn and is idle."]),
      );
      assert.equal(world.sent.length, 1);
    }),
  );
});

it.effect("a lead settled between its read and the wake stays settled and is sent nothing", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      // The user settles it just after the wake read it as active.
      world.hooks.afterLeadRead = () =>
        Effect.sync(() => {
          world.hooks.afterLeadRead = () => Effect.void;
          world.set(lead, { settledAt: "2026-01-02" });
        });
      yield* world.run(first, "f1", "completed");
      yield* world.leadRead;
      assert.equal(yield* Queue.size(world.woke), 0);
      world.set(lead, { settledAt: null });
      yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
      yield* world.run(second, "s1", "failed");
      // The settled wake was put away, not held for the lead's return.
      assert.equal(yield* nextText(world), told(["thread second on this machine failed."]));
      assert.equal(world.sent.length, 1);
    }),
  );
});

it.effect(
  "a new lead gets the updates: one asked while the wake read is held, one while the old lead ran",
  () => {
    const world = makeWorld();
    return withWakes(
      world,
      Effect.gen(function* () {
        // The user gives the Mission a new lead while a wake reads the old one. It lands at once
        // unless the wake holds the Mission's lock, and then waits for the wake.
        const scope = yield* Effect.scope;
        let changing: Fiber.Fiber<boolean> | undefined;
        world.hooks.onLeadRead = () =>
          Effect.gen(function* () {
            world.hooks.onLeadRead = () => Effect.void;
            if (yield* world.setLead(second, lead, true)) return;
            changing = yield* world.setLead(second, lead).pipe(Effect.forkIn(scope));
          });
        yield* world.run(first, "f1", "completed");
        const firstWake = yield* Queue.take(world.woke);
        // The wake goes to whoever leads when it is sent.
        assert.equal(firstWake.threadId, firstWake.leadNow);
        assert.isDefined(changing);
        yield* Fiber.join(changing!);
        // Now the old lead is busy, and an update comes; the new lead, idle, hears it.
        yield* world.leadRead;
        world.set(lead, busy);
        yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
        yield* world.run(first, "f2", "failed");
        const secondWake = yield* Queue.take(world.woke);
        assert.equal(secondWake.threadId, second);
        assert.equal(secondWake.text, told(["thread first on this machine failed."]));
      }),
    );
  },
);

it.effect("a lead busy when it is replaced: the new lead gets what waited", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      world.set(lead, busy);
      yield* world.run(first, "f1", "completed");
      yield* world.leadRead;
      yield* world.setLead(second, lead);
      const wake = yield* Queue.take(world.woke);
      assert.deepEqual(
        [wake.threadId, wake.text],
        [second, told(["thread first on this machine finished its turn and is idle."])],
      );
    }),
  );
});

it.effect("a second completion while a wake is sent stays for the next wake", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      // Recorded after the wake was taken and before it is cleared.
      world.hooks.afterDispatch = () => {
        world.hooks.afterDispatch = () => Effect.void;
        return world.session.store!.addMissionUpdate({
          missionId: MISSION,
          environmentId: HERE,
          threadId: first,
          source: "run:f2",
          event: "completed",
        });
      };
      yield* world.run(first, "f1", "completed");
      yield* Queue.take(world.woke);
      yield* world.leadRead;
      yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
      // The lead's own run ending asks for the next wake.
      yield* world.run(lead, "l1", "completed");
      assert.equal(
        yield* nextText(world),
        told(["thread first on this machine finished its turn and is idle."]),
      );
      assert.equal(world.sent.length, 2);
    }),
  );
});

it.effect("a stop after the wake was taken and before it was cleared sends it once", () => {
  const world = makeWorld();
  return withWakes(
    world,
    Effect.gen(function* () {
      world.hooks.afterDispatch = () => {
        world.hooks.afterDispatch = () => Effect.void;
        return Effect.die("the server stopped");
      };
      yield* world.run(first, "f1", "completed");
      yield* Queue.take(world.woke);
    }),
    Effect.gen(function* () {
      // On the next start the wake goes again with the same command, which the orchestrator replays.
      yield* world.leadRead;
      yield* TestClock.adjust(MissionWakes.WAKE_INTERVAL);
      yield* world.run(second, "s1", "failed");
      assert.equal(yield* nextText(world), told(["thread second on this machine failed."]));
      assert.equal(world.sent.length, 2);
      assert.notEqual(world.sent[0]!.commandId, world.sent[1]!.commandId);
    }),
  );
});

it.effect(
  "a member on another machine is told by its run and request ids, also after a restart",
  () => {
    const world = makeWorld();
    const laptop = { environmentId: LAPTOP, threadId: first };
    return withWakes(
      world,
      Effect.gen(function* () {
        // The first list only leaves a mark.
        yield* world.listed(laptop, { run: { id: "run-1", status: "completed" } });
        yield* world.listed(laptop, {
          status: "awaiting-input",
          run: { id: "run-1", status: "completed" },
          requests: [{ id: "req-1", kind: "user_input" }],
        });
        assert.equal(
          yield* nextText(world),
          told(["thread first on env-laptop is awaiting input."]),
        );
      }),
      Effect.gen(function* () {
        // After a restart, the next list is compared with the mark the last one left: a run that
        // started and ended while the server was down still wakes the lead.
        yield* world.listed(laptop, { run: { id: "run-2", status: "completed" } });
        assert.equal(
          yield* nextText(world),
          told(["thread first on env-laptop finished its turn and is idle."]),
        );
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
      assert.equal(yield* nextText(world), told(["thread second on this machine failed."]));
      assert.equal(world.sent.length, 3);
    }),
  );
});
