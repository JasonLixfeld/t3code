import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { missionWakeCommand } from "../missions/MissionWakes.ts";

const instanceId = ProviderInstanceId.make("codex");
const seen: Array<boolean> = [];
const sees = <A>(answer: A) =>
  Effect.map(Orchestrator.UnlessParked, (unlessParked) => {
    seen.push(unlessParked);
    return answer;
  });
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => sees(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => sees({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for a wake that is not sent"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "unless-parked" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:lead");
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);

const wakeCommand = (id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`wake-${id}`),
  threadId,
  messageId: MessageId.make(`message:wake-${id}`),
  text: "Mission update: member 1 on this machine failed.",
  attachments: [],
  dispatchMode: { type: "queue_after_active" as const },
  createdBy: "agent" as const,
  creationSource: "server" as const,
});

const settledLead = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:lead"),
    title: "Lead",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.settle",
    commandId: CommandId.make("settle"),
    threadId,
  });
  return orchestrator;
});

it.effect("a client's command cannot ask to be sent unless parked", () =>
  Effect.gen(function* () {
    const orchestrator = yield* settledLead;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sent = yield* decodeCommand({
      ...wakeCommand("client"),
      unlessParked: true,
    });
    assert.notProperty(sent, "unlessParked");
    yield* orchestrator.dispatch(sent);
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a wake to a settled lead sends nothing and leaves an unread steer for later", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const wake = (id: string) =>
      orchestrator
        .dispatch(wakeCommand(id))
        .pipe(Effect.provideService(Orchestrator.UnlessParked, true));
    yield* settledLead;
    yield* wake("1");
    yield* wake("1");
    const settled = yield* projections.getThreadProjection(threadId);
    assert.equal(settled.thread.settledOverride, "settled");
    assert.deepEqual(settled.messages, []);
    assert.deepEqual(settled.runs, []);
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-first"),
      threadId,
      reason: "user",
    });
    const send = (id: string, type: "start_immediately" | "queue_after_active") =>
      orchestrator.dispatch({
        ...wakeCommand(id),
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        text: id,
        dispatchMode: { type },
        createdBy: "user",
        creationSource: "web",
      });
    yield* send("first", "start_immediately");
    const before = yield* projections.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:run-ended"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const message = before.messages.find((candidate) => candidate.id === "first")!;
    const item = before.turnItems.find((candidate) => candidate.type === "user_message")!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:steer-message"),
          type: "message.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...message, id: MessageId.make("steer"), text: "Steer" },
        },
        {
          id: EventId.make("event:steer-item"),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...item,
            id: "turn-item:steer",
            messageId: MessageId.make("steer"),
            status: "pending",
            inputIntent: "steer",
          } as never,
        },
        {
          id: EventId.make("event:settled"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...before.thread, settledOverride: "settled", settledAt: now },
        },
      ],
    });
    yield* wake("steer");
    const parked = yield* projections.getThreadProjection(threadId);
    assert.equal(parked.thread.settledOverride, "settled");
    assert.deepEqual(
      parked.runs.map((candidate) => candidate.userMessageId),
      [MessageId.make("first")],
    );
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-again"),
      threadId,
      reason: "user",
    });
    yield* send("next", "queue_after_active");
    assert.deepEqual(
      (yield* projections.getThreadProjection(threadId)).runs.map(
        (candidate) => candidate.userMessageId,
      ),
      [MessageId.make("first"), MessageId.make("steer"), MessageId.make("next")],
    );
    yield* wake("2");
    assert.include(
      (yield* projections.getThreadProjection(threadId)).messages.map((candidate) => candidate.id),
      MessageId.make("message:wake-2"),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a mission wake keeps the lead's snooze, as a delegated result does", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* settledLead;
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle"),
      threadId,
      reason: "user",
    });
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("snooze"),
      threadId,
      snoozedUntil: "2999-01-01T00:00:00.000Z",
    });
    yield* orchestrator
      .dispatch(
        missionWakeCommand({
          missionId: "0123456789ab",
          key: "k1",
          lead: threadId,
          text: "Mission update: member 1 on this machine failed.",
        }),
      )
      .pipe(Effect.provideService(Orchestrator.UnlessParked, true));
    const lead = yield* projections.getThreadProjection(threadId);
    assert.isNotNull(lead.thread.snoozedUntil);
    assert.deepEqual(
      lead.messages.map((candidate) => candidate.text),
      ["Mission update: member 1 on this machine failed."],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("what a wake's dispatch runs in turn never reads it as unless parked", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* settledLead;
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle"),
      threadId,
      reason: "user",
    });
    seen.length = 0;
    yield* orchestrator
      .dispatch(wakeCommand("open"))
      .pipe(Effect.provideService(Orchestrator.UnlessParked, true));
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 1);
    assert.isNotEmpty(seen);
    assert.notInclude(seen, true);
  }).pipe(Effect.provide(layerTest)),
);
