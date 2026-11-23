import {
  type Mission,
  MissionError,
  missionTag,
  type MissionsSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { MissionStore } from "./MissionStore.ts";
import { applyMissionTags, type MissionTagChange } from "./MissionTags.ts";

export class Missions extends Context.Service<
  Missions,
  {
    /** The Missions here and the links that can reach member threads, now and after each change. */
    readonly watch: Stream.Stream<MissionsSnapshot>;
    /** Starts a Mission led by a thread on this machine. */
    readonly create: (input: {
      readonly name: string;
      readonly leadThreadId: ThreadId;
    }) => Effect.Effect<Mission, MissionError>;
    readonly addMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
    }) => Effect.Effect<void, MissionError>;
    /** With `leaveTag`, drops the membership and leaves the member's tag as it is. */
    readonly releaseMember: (input: {
      readonly missionId: string;
      readonly member: ScopedThreadRef;
      readonly leaveTag?: boolean | undefined;
    }) => Effect.Effect<void, MissionError>;
  }
>()("t3/missions/Missions") {}

const fail = (message: string, reason?: MissionError["reason"]) =>
  Effect.fail(new MissionError({ message, ...(reason === undefined ? {} : { reason }) }));

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const random = yield* SecureRandom.SecureRandom;
  const here = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const local = yield* Effect.context<
    ThreadManagement.ThreadManagementService | SecureRandom.SecureRandom
  >();
  // One change at a time, so the membership check and the write that follows it agree.
  const lock = yield* Semaphore.make(1);

  const missionLinks = Effect.gen(function* () {
    if (!(yield* links.enabled)) return [];
    const names = yield* links.names;
    return yield* Effect.forEach(names, (name) =>
      links.get(name.environmentId).pipe(
        Effect.map((link) => ({
          environmentId: name.environmentId,
          label: name.label,
          fullAccess: Option.isSome(link) && link.value.access === "full-access",
        })),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Mission links could not be read", error).pipe(Effect.as([])),
    ),
  );

  const snapshot = Effect.all({ missions: store.list, links: missionLinks });

  /** Changes the tag on the member's own machine. A machine that does not answer fails the change. */
  const tagMember = Effect.fn("Missions.tagMember")(function* (
    member: ScopedThreadRef,
    change: MissionTagChange,
  ) {
    if (member.environmentId === here) {
      return yield* applyMissionTags(member.threadId, change).pipe(Effect.provideContext(local));
    }
    if (!(yield* links.enabled)) {
      return yield* fail(PeerLinks.LINKED_ENVIRONMENTS_OFF, "unreachable");
    }
    const link = yield* links
      .get(member.environmentId)
      .pipe(Effect.catch((error) => fail(error.message, "unreachable")));
    if (Option.isNone(link)) {
      return yield* fail(
        "This machine has no link to the thread's machine. Link them in Settings → Connections first.",
        "unreachable",
      );
    }
    const { label, access } = link.value;
    if (access !== "full-access") {
      return yield* fail(
        `The link to ${label} has ${access} access. A link below full access may change only threads it started, so relink ${label} with full access to use its threads in a mission.`,
        "unreachable",
      );
    }
    yield* peers
      .call({
        environmentId: member.environmentId,
        tool: "t3_mission_tag",
        arguments: {
          threadId: member.threadId,
          change: change.kind,
          missionId: change.missionId,
          name: change.name,
        },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: Schema.Struct({ threadId: ThreadId }),
      })
      .pipe(
        Effect.catch((error) =>
          fail(
            `${label} did not change the thread's mission tag, so nothing changed. ${error.message}`,
            error.code === "thread_not_found"
              ? "thread-gone"
              : error.code === "invalid_request"
                ? undefined
                : "unreachable",
          ),
        ),
      );
  });

  /** Keeps a join only if the store records it; otherwise takes the tag back off the thread. */
  const recordOrUndo = Effect.fn("Missions.recordOrUndo")(function* (
    member: ScopedThreadRef,
    change: MissionTagChange,
    record: Effect.Effect<boolean>,
  ) {
    const recorded = yield* Effect.exit(record);
    if (Exit.isSuccess(recorded) && recorded.value) return;
    if (Exit.isFailure(recorded)) {
      yield* Effect.logError("A mission membership was not saved", recorded.cause);
    }
    const why = Exit.isSuccess(recorded)
      ? "This thread joined another mission meanwhile, so it was not added."
      : "This machine could not save the mission, so the thread was not added.";
    yield* tagMember(member, { ...change, kind: "undo" }).pipe(
      Effect.catch((error) =>
        fail(
          `${why} Taking its tag "${missionTag(change.missionId, change.name)}" off again also failed, so remove that tag by hand. ${error.message}`,
        ),
      ),
    );
    return yield* fail(`${why} Its mission tag was taken off again.`);
  });

  const missionNamed = Effect.fn("Missions.find")(function* (missionId: string) {
    const mission = (yield* store.list).find((candidate) => candidate.missionId === missionId);
    return mission ?? (yield* fail("That mission was not found."));
  });

  const refuseTaken = Effect.fn("Missions.refuseTaken")(function* (ref: ScopedThreadRef) {
    const taken = yield* store.missionOf(ref);
    if (taken !== undefined) {
      return yield* fail(`This thread is already in the mission "${taken.name}".`);
    }
  });

  const create = Effect.fn("Missions.create")(function* (input: {
    readonly name: string;
    readonly leadThreadId: ThreadId;
  }) {
    const lead = { environmentId: here, threadId: input.leadThreadId };
    yield* refuseTaken(lead);
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
    const missionId = uuid.replaceAll("-", "").slice(0, 12);
    const change = { kind: "join", missionId, name: input.name } as const;
    yield* tagMember(lead, change);
    yield* recordOrUndo(lead, change, store.create({ missionId, name: input.name, lead }));
    return yield* missionNamed(missionId);
  }, lock.withPermits(1));

  const addMember = Effect.fn("Missions.addMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
  }) {
    const mission = yield* missionNamed(input.missionId);
    yield* refuseTaken(input.member);
    const change = { kind: "join", missionId: mission.missionId, name: mission.name } as const;
    yield* tagMember(input.member, change);
    yield* recordOrUndo(input.member, change, store.addMember(mission.missionId, input.member));
  }, lock.withPermits(1));

  const releaseMember = Effect.fn("Missions.releaseMember")(function* (input: {
    readonly missionId: string;
    readonly member: ScopedThreadRef;
    readonly leaveTag?: boolean | undefined;
  }) {
    const mission = yield* missionNamed(input.missionId);
    const member = mission.members.find(
      (candidate) =>
        candidate.ref.environmentId === input.member.environmentId &&
        candidate.ref.threadId === input.member.threadId,
    );
    if (member === undefined) return yield* fail("That thread is not in this mission.");
    if (member.role === "lead") {
      return yield* fail("A mission keeps its lead thread, so the lead cannot be released.");
    }
    if (input.leaveTag !== true) {
      // A thread deleted on its machine has no tag left to change.
      yield* tagMember(input.member, {
        kind: "leave",
        missionId: mission.missionId,
        name: mission.name,
      }).pipe(
        Effect.catchIf(
          (error) => error.reason === "thread-gone",
          () => Effect.void,
        ),
      );
    }
    yield* store.removeMember(mission.missionId, input.member);
  }, lock.withPermits(1));

  const watch = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so a change in between is not missed.
      const changes = yield* PubSub.subscribe(store.changes);
      return Stream.concat(
        Stream.fromEffect(snapshot),
        Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => snapshot)),
      );
    }),
  );

  return Missions.of({ watch, create, addMember, releaseMember });
});

export const layer = Layer.effect(Missions, make);
