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
  /** This Mission's own prompt for its lead. Empty or absent: the lead gets the Settings default. */
  prompt: Schema.optional(Schema.String),
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

/** The Mission's name is its lead thread's title, so the client sends none. */
export const MissionCreateInput = Schema.Struct({
  /** Chosen by the client, so a retry after a lost reply finds the Mission it already made. */
  missionId: MissionId,
  leadThreadId: ThreadId,
});

export const MissionMemberInput = Schema.Struct({
  missionId: Schema.String,
  member: ScopedThreadRef,
});

/** A thread on the Mission's own machine takes over as its lead, as when the old one is gone. */
export const MissionSetLeadInput = Schema.Struct({
  missionId: Schema.String,
  lead: ScopedThreadRef,
  /** The lead the asker saw. Only that lead is replaced, so a stale ask cannot undo a newer one. */
  expectedLead: ThreadId,
});

/** Ends a Mission with no members. Its lead stays a thread of its own. */
export const MissionDeleteInput = Schema.Struct({ missionId: Schema.String });

/** Sets the Mission's own prompt for its lead. Empty text goes back to the Settings default. */
export const MissionSetPromptInput = Schema.Struct({
  missionId: Schema.String,
  prompt: Schema.String,
});

/**
 * What became of a thread a mission's lead started: it joined the lead's Mission, it waits on
 * its machine's answer, or it was refused and stays a thread of its own, for `reason`.
 */
export const MissionJoinOutcome = Schema.Struct({
  state: Schema.Literals(["joined", "pending", "refused"]),
  reason: Schema.optional(Schema.String),
});
export type MissionJoinOutcome = typeof MissionJoinOutcome.Type;

/** The local user frees a thread on this machine from its Mission. */
export const MissionLeaveInput = Schema.Struct({ threadId: ThreadId });

export class MissionError extends Schema.TaggedError<MissionError>()("MissionError", {
  message: Schema.String,
  /**
   * `lead-changed`: another ask gave the Mission a new lead first, so asking again cannot help.
   * `denied`: the asking lead agent may not change that thread, or reach its machine.
   */
  reason: Schema.optional(Schema.Literals(["lead-changed", "denied"])),
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

/** A Mission is named for its lead thread's title, kept to the tag rules. */
export const missionNameFromTitle = (title: string) =>
  cut(title.replace(/\p{Cc}+/gu, " ").trim()) || "Mission";

/**
 * Only a thread with messages may lead a Mission: an empty draft thread is deleted on its own,
 * which would leave the Mission without its lead.
 */
export const threadHasMessages = (thread: {
  readonly latestUserMessageAt: unknown;
  readonly visibleItemCount: number;
}) => thread.latestUserMessageAt != null || thread.visibleItemCount > 0;

/** The label a member thread carries. The id comes first so a cut name or a rename still matches. */
export const missionTag = (missionId: string, name: string) =>
  cut(`${MISSION_TAG_PREFIX}${missionId}:${name}`);
export const missionWasTag = (missionId: string, name: string) =>
  cut(`${MISSION_WAS_TAG_PREFIX}${missionId}:${name}`);

/** Mission tags mirror claims, so only the Missions code may write them. */
export const isMissionTag = (tag: string) =>
  tag.startsWith(MISSION_TAG_PREFIX) || tag.startsWith(MISSION_WAS_TAG_PREFIX);
