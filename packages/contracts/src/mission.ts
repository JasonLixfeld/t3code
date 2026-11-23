import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ThreadTag } from "./threadTags.ts";

export const MissionMember = Schema.Struct({
  ref: ScopedThreadRef,
  role: Schema.Literals(["lead", "member"]),
  addedAt: Schema.String,
});
export type MissionMember = typeof MissionMember.Type;

/** A Mission lives on its lead thread's machine. `members` lists the lead first. */
export const Mission = Schema.Struct({
  missionId: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  members: Schema.Array(MissionMember),
});
export type Mission = typeof Mission.Type;

/** A machine this one links to. Only a full-access link may tag a thread it did not start. */
export const MissionLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  fullAccess: Schema.Boolean,
});
export type MissionLink = typeof MissionLink.Type;

export const MissionsSnapshot = Schema.Struct({
  missions: Schema.Array(Mission),
  links: Schema.Array(MissionLink),
});
export type MissionsSnapshot = typeof MissionsSnapshot.Type;

export const MissionsSubscribeInput = Schema.Struct({});

/** The name goes into each member's tag, so it follows the tag rules. */
const MissionName = ThreadTag;

export const MissionCreateInput = Schema.Struct({
  name: MissionName,
  leadThreadId: ThreadId,
});

export const MissionMemberInput = Schema.Struct({
  missionId: Schema.String,
  member: ScopedThreadRef,
});

export class MissionError extends Schema.TaggedError<MissionError>()("MissionError", {
  message: Schema.String,
}) {}

export const MISSION_TAG_PREFIX = "mission:";
export const MISSION_WAS_TAG_PREFIX = "mission-was:";
const THREAD_TAG_MAX_LENGTH = 64;

const cut = (tag: string) => tag.slice(0, THREAD_TAG_MAX_LENGTH).trimEnd();

/** The label a member thread carries. The id comes first so a cut name or a rename still matches. */
export const missionTag = (missionId: string, name: string) =>
  cut(`${MISSION_TAG_PREFIX}${missionId}:${name}`);
export const missionWasTag = (missionId: string, name: string) =>
  cut(`${MISSION_WAS_TAG_PREFIX}${missionId}:${name}`);

/** The Mission a thread's tags say it belongs to, if any. */
export const missionTagOf = (tags: ReadonlyArray<string> | undefined) =>
  tags?.find((tag) => tag.startsWith(MISSION_TAG_PREFIX));
