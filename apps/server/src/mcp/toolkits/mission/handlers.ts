import {
  MissionError,
  type MissionJoinOutcome,
  OrchestratorMcpFailure,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { linkOwner, MissionClaims } from "../../../missions/MissionClaims.ts";
import * as Missions from "../../../missions/Missions.ts";
import {
  cutToBytes,
  GET_THE_BRIEF,
  needsAttention,
  type RosterMember,
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

/** As t3_thread_read: Claude Code saves an MCP answer past about 25k tokens to a file. */
const ROSTER_MAX_BYTES = 30_000;
const jsonBytes = (answer: object) => Buffer.byteLength(JSON.stringify(answer), "utf8");

const byRepository = (rows: ReadonlyArray<RosterMember>) => {
  const groups = new Map<string, Array<{ readonly member: string; readonly place: string }>>();
  for (const row of rows) {
    if (row.workspace === undefined || typeof row.workspace === "string") continue;
    for (const repository of row.workspace.repositories) {
      const key =
        repository.remote === null
          ? `${row.ref.environmentId}:${repository.repositoryPath}`
          : sourceControlDefinitions.canonicalRepositoryKey(repository.remote);
      groups.set(key, [...(groups.get(key) ?? []), { member: row.member, place: row.place }]);
    }
  }
  return [...groups].map(([repository, members]) => ({ repository, members }));
};

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

export const layer = McpToolAccess.toLayer(
  MissionToolkit,
  Effect.gen(function* () {
    const missions = yield* Effect.serviceOption(Missions.Missions);
    const leadsNone = () =>
      new OrchestratorMcpFailure({ code: "invalid_request", message: Missions.LEADS_NO_MISSION });
    const callerHere = Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "This mission tool");
      if (Option.isNone(missions)) return yield* leadsNone();
      return {
        missions: missions.value,
        environmentId: scope.environmentId,
        lead: caller.thread.threadId,
      };
    });
    const callersMission = Effect.gen(function* () {
      const caller = yield* callerHere;
      const mission = yield* caller.missions.ledBy(caller.lead);
      if (mission === undefined) return yield* leadsNone();
      return { ...caller, mission };
    });
    return {
      t3_mission_tag: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const claims = yield* MissionClaims;
            const mayChange = yield* McpToolAccess.threadWriteAccess;
            const owner =
              scope.client === undefined ? scope.environmentId : linkOwner(scope.client.sessionId);
            if (input.kind === "list") return yield* claims.listWithDetail(owner);
            if (input.kind === "workspaces") {
              return yield* claims.listWithDetail(owner, yield* needs(input.members, "members"));
            }
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
          const listed = yield* missions.roster(mission.missionId);
          const cursor = input.cursor ?? 0;
          let rows = listed;
          const page = (end: number) => ({
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
          });
          const last = Math.min(rows.length, cursor + (input.limit ?? 10));
          let end = Math.min(last, cursor + 1);
          if (end > cursor && jsonBytes(page(end)) > ROSTER_MAX_BYTES) {
            const alone = listed[cursor]!;
            rows = listed.with(cursor, { ...alone, title: "", project: "", machine: "" });
            const tooLarge =
              typeof alone.workspace === "object" && jsonBytes(page(end)) > ROSTER_MAX_BYTES;
            rows = listed.with(cursor, tooLarge ? { ...alone, workspace: "tooLarge" } : alone);
            for (const field of ["title", "project", "machine"] as const) {
              let over = jsonBytes(page(end)) - ROSTER_MAX_BYTES;
              while (over > 0 && rows[cursor]![field] !== "") {
                const text = rows[cursor]![field];
                const kept = Math.max(0, Buffer.byteLength(text, "utf8") - over);
                rows = rows.with(cursor, { ...rows[cursor]!, [field]: cutToBytes(text, kept) });
                over = jsonBytes(page(end)) - ROSTER_MAX_BYTES;
              }
            }
          }
          while (end < last && jsonBytes(page(end + 1)) <= ROSTER_MAX_BYTES) {
            end += 1;
          }
          return page(end);
        }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) })),
      ),
      t3_mission_add: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { missions, environmentId, lead } = yield* callerHere;
          const { state, needsBrief } = yield* missions.addAsLead(lead, {
            environmentId: input.threadRef.environmentId ?? environmentId,
            threadId: input.threadRef.threadId,
          });
          return needsBrief ? { state, next: PRIOR_WORK_NEXT } : { state };
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
      t3_mission_start: McpToolAccess.actsAsCaller(() =>
        Effect.gen(function* () {
          const { missions, lead } = yield* callerHere;
          const { missionId, name } = yield* missions.startAsLead(lead);
          return { missionId, name };
        }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(refused(error)) })),
      ),
    };
  }),
);
