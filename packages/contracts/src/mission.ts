import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ThreadTag } from "./threadTags.ts";

export const MissionMember = Schema.Struct({
  ref: ScopedThreadRef,
  role: Schema.Literals(["lead", "member"]),
  /**
   * `offline`: its machine does not answer, so this is what it last said. `deleted`: the lead
   * thread is gone. `release-pending`, `add-pending`: that machine has not answered the release
   * or the add yet. `add-refused`: it turned the add down, and `detail` says why.
   */
  state: Schema.Literals([
    "active",
    "offline",
    "release-pending",
    "deleted",
    "add-pending",
    "add-refused",
  ]),
  detail: Schema.optional(Schema.String),
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

/** A thread on this machine that a Mission holds, whichever machine leads it. */
export const MissionClaimHere = Schema.Struct({
  threadId: ThreadId,
  missionId: Schema.String,
  name: Schema.String,
});
export type MissionClaimHere = typeof MissionClaimHere.Type;

export const MissionsSnapshot = Schema.Struct({
  missions: Schema.Array(Mission),
  links: Schema.Array(MissionLink),
  claims: Schema.Array(MissionClaimHere),
});
export type MissionsSnapshot = typeof MissionsSnapshot.Type;

export const MissionsSubscribeInput = Schema.Struct({});

/** Twelve hex digits. The id goes into each member's tag, where a colon ends it. */
export const MissionId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/));
/** The name goes into each member's tag, so it follows the tag rules. */
export const MissionName = ThreadTag;

export const MissionCreateInput = Schema.Struct({
  /** Chosen by the client, so a retry after a lost reply finds the Mission it already made. */
  missionId: MissionId,
  name: MissionName,
  leadThreadId: ThreadId,
});

export const MissionMemberInput = Schema.Struct({
  missionId: Schema.String,
  member: ScopedThreadRef,
});

/** The local user frees a thread on this machine from its Mission. */
export const MissionLeaveInput = Schema.Struct({ threadId: ThreadId });

export class MissionError extends Schema.TaggedError<MissionError>()("MissionError", {
  message: Schema.String,
}) {}

export const MISSION_TAG_PREFIX = "mission:";
export const MISSION_WAS_TAG_PREFIX = "mission-was:";
const THREAD_TAG_MAX_LENGTH = 64;

/** Cuts whole code points, so an emoji is never split into a lone surrogate. */
const cut = (tag: string) => {
  let kept = "";
  for (const codePoint of tag) {
    if (kept.length + codePoint.length > THREAD_TAG_MAX_LENGTH) break;
    kept += codePoint;
  }
  return kept.trimEnd();
};

/** The label a member thread carries. The id comes first so a cut name or a rename still matches. */
export const missionTag = (missionId: string, name: string) =>
  cut(`${MISSION_TAG_PREFIX}${missionId}:${name}`);
export const missionWasTag = (missionId: string, name: string) =>
  cut(`${MISSION_WAS_TAG_PREFIX}${missionId}:${name}`);

/** Mission tags mirror claims, so only the Missions code may write them. */
export const isMissionTag = (tag: string) =>
  tag.startsWith(MISSION_TAG_PREFIX) || tag.startsWith(MISSION_WAS_TAG_PREFIX);
