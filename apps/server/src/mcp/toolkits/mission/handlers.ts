import {
  MissionError,
  type MissionJoinOutcome,
  OrchestratorMcpFailure,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { linkOwner, MissionClaims } from "../../../missions/MissionClaims.ts";
import type { MissionClaim } from "../../../missions/MissionStore.ts";
import * as Missions from "../../../missions/Missions.ts";
import {
  GET_THE_BRIEF,
  memberDetail,
  needsAttention,
  type RosterMember,
  withinWorkspaceRoom,
} from "../../../missions/missionStatus.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MissionToolkit } from "./tools.ts";

type MissionsService = Missions.Missions["Service"];

const needs = <A>(value: A | undefined, field: string) =>
  value === undefined
    ? Effect.fail(new MissionError({ message: `This kind of call needs ${field}.` }))
    : Effect.succeed(value);

const PRIOR_WORK_NEXT = `This thread has prior work. ${GET_THE_BRIEF}`;

const refused = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "denied" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const byRepository = (rows: ReadonlyArray<RosterMember>) => {
  const groups = new Map<
    string,
    Array<{
      readonly member: string;
      readonly place: string;
      readonly branch: string | null;
      readonly branchSource: "live" | "recorded";
      readonly pullRequests: ReadonlyArray<{ number: number; state: string; url: string }>;
    }>
  >();
  for (const row of rows) {
    if (row.workspace === undefined || typeof row.workspace === "string") continue;
    for (const repository of row.workspace.repositories) {
      const key =
        repository.remote === null
          ? `${row.ref.environmentId}:${repository.repositoryPath}`
          : sourceControlDefinitions.canonicalRepositoryKey(repository.remote);
      groups.set(key, [
        ...(groups.get(key) ?? []),
        {
          member: row.member,
          place: row.place,
          branch: repository.branch,
          branchSource: repository.branchSource,
          pullRequests: repository.pullRequests,
        },
      ]);
    }
  }
  return [...groups].map(([repository, members]) => ({ repository, members }));
};

/**
 * A top-level thread a mission's lead started joins its Mission, with the lead's own reach. A
 * refused join leaves the thread as it is, and says why. A replayed start, and any other caller's
 * threads, join nothing.
 */
export const joinCallersMission = Effect.fn("MissionHandlers.joinCallersMission")(function* (
  missions: Option.Option<MissionsService>,
  member: ScopedThreadRef,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (Option.isNone(missions) || scope.thread === undefined) return undefined;
  const mission = yield* missions.value.ledBy(scope.thread.threadId);
  if (mission === undefined) return undefined;
  return yield* missions.value
    .joinStarted({ missionId: mission.missionId, member }, scope.thread.threadId)
    .pipe(
      Effect.map((state): MissionJoinOutcome | undefined =>
        state === undefined ? undefined : { state },
      ),
      Effect.catchTags({
        MissionError: (error) =>
          Effect.succeed<MissionJoinOutcome>({ state: "refused", reason: error.message }),
      }),
    );
});

// Only a linked environment's session can call t3_mission_tag (see `shownOnlyToLinks`).
// `writesThreads` holds a link below full access to the threads it started, and the claim code
// makes that check again under the thread's lock. A release drops only a claim its own caller
// holds. The lead tools act only on the Mission the calling thread leads.
export const layer = McpToolAccess.toLayer(
  MissionToolkit,
  Effect.gen(function* () {
    const missions = yield* Effect.serviceOption(Missions.Missions);
    /** The caller's own Mission, never one named in the input. */
    const callersMission = Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "This mission tool");
      const mission = Option.isNone(missions)
        ? undefined
        : yield* missions.value.ledBy(caller.thread.threadId);
      if (Option.isNone(missions) || mission === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This thread leads no mission.",
        });
      }
      return {
        missions: missions.value,
        mission,
        environmentId: scope.environmentId,
        // The lead's reach is read from this thread under the Mission's lock, not from the call.
        lead: caller.thread.threadId,
      };
    });
    return {
      t3_mission_tag: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const claims = yield* MissionClaims;
            const mayChange = yield* McpToolAccess.threadWriteAccess;
            // The owner comes from the authenticated caller, never from the input.
            const owner =
              scope.client === undefined ? scope.environmentId : linkOwner(scope.client.sessionId);
            // Each claim says what its thread is doing, so the lead can tell when it needs it.
            const withDetail = Effect.fn("MissionHandlers.withDetail")(function* (
              wanted: ReadonlyArray<MissionClaim>,
            ) {
              const read = yield* Effect.forEach(wanted, (claim) =>
                Effect.map(memberDetail(claim.threadId), (detail) => ({ claim, detail })),
              );
              // A claim may have changed hands while its thread was read.
              const held = yield* claims.list(owner);
              return withinWorkspaceRoom(
                read.map(({ claim, detail }) =>
                  detail === undefined ||
                  !held.some(
                    (now) => now.threadId === claim.threadId && now.generation === claim.generation,
                  )
                    ? claim
                    : { ...claim, detail },
                ),
              );
            });
            if (input.kind === "list") return yield* withDetail(yield* claims.list(owner));
            if (input.kind === "workspaces") {
              const members = yield* needs(input.members, "members");
              return yield* withDetail(
                (yield* claims.list(owner)).filter((claim) =>
                  members.some(
                    (member) =>
                      member.threadId === claim.threadId && member.generation === claim.generation,
                  ),
                ),
              );
            }
            // Renames only claims this caller holds, each checked as a join is; a thread the caller
            // may no longer change keeps the old name.
            if (input.kind === "rename") {
              return yield* claims.rename(
                owner,
                {
                  missionId: yield* needs(input.missionId, "missionId"),
                  name: yield* needs(input.name, "name"),
                },
                mayChange,
              );
            }
            const threadId = yield* needs(input.threadId, "threadId");
            switch (input.kind) {
              case "join": {
                const joined = yield* claims.join(
                  owner,
                  {
                    threadId,
                    missionId: yield* needs(input.missionId, "missionId"),
                    name: yield* needs(input.name, "name"),
                    intentId: input.intentId,
                  },
                  mayChange,
                );
                return joined === "intent-spent" ? [] : [joined];
              }
              case "release":
                yield* claims.release(
                  owner,
                  {
                    threadId,
                    missionId: yield* needs(input.missionId, "missionId"),
                    generation: yield* needs(input.generation, "generation"),
                  },
                  mayChange,
                );
                return [];
            }
          }).pipe(
            Effect.map((claims) => ({ claims })),
            Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) }),
          ),
      ),
      t3_mission_roster: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const { missions, mission } = yield* callersMission;
          const rows = yield* missions.roster(mission.missionId);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 10);
          return {
            missionId: mission.missionId,
            name: mission.name,
            members: rows.slice(cursor, end).map((row) => ({
              member: row.member,
              place: row.place,
              threadRef: row.ref,
              machine: row.machine,
              project: row.project,
              status: row.status,
              title: row.title,
              needsAttention: needsAttention(row.status),
              workspace: row.workspace ?? ("unknown" as const),
            })),
            byRepository: byRepository(rows.slice(cursor, end)),
            total: rows.length,
            nextCursor: end < rows.length ? end : null,
          };
        }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) })),
      ),
      t3_mission_add: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { missions, mission, environmentId, lead } = yield* callersMission;
          const member = {
            environmentId: input.threadRef.environmentId ?? environmentId,
            threadId: input.threadRef.threadId,
          };
          // A thread already in keeps its claim: nothing joined, so there is no brief to get.
          const already = (yield* missions.memberStatuses(mission.missionId)).some(
            (row) =>
              row.ref.environmentId === member.environmentId &&
              row.ref.threadId === member.threadId,
          );
          const state = yield* missions.addMember({ missionId: mission.missionId, member }, lead);
          return state === "joined" && !already && (yield* missions.hasPriorWork(mission, member))
            ? { state, next: PRIOR_WORK_NEXT }
            : { state };
        }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) })),
      ),
      t3_mission_release: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { missions, mission, environmentId, lead } = yield* callersMission;
          const member = {
            environmentId: input.threadRef.environmentId ?? environmentId,
            threadId: input.threadRef.threadId,
          };
          return {
            state: yield* missions.releaseMember({ missionId: mission.missionId, member }, lead),
          };
        }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) })),
      ),
    };
  }),
);
