import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ThreadTag } from "./threadTags.ts";

export const MissionMember = Schema.Struct({
  ref: ScopedThreadRef,
  role: Schema.Literals(["lead", "member"]),
  /**
   * `offline` is last known. A `release-refused` thread is still a member. `detail` explains
   * refusals.
   */
  state: Schema.Literals([
    "active",
    "offline",
    "release-pending",
    "release-refused",
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
  /**
   * This Mission's own prompt for its lead. Empty or absent: the lead gets the Settings default.
   * A list asked for with `omitPrompts` leaves it out.
   */
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
const MissionClaimHere = Schema.Struct({
  threadId: ThreadId,
  missionId: Schema.String,
  name: Schema.String,
});

export const MissionsSnapshot = Schema.Struct({
  missions: Schema.Array(Mission),
  links: Schema.Array(MissionLink),
  /** Set when `links` is empty because the session may not read them. */
  linksHidden: Schema.optional(Schema.Literal(true)),
  /** Set when the list leaves prompts out. Older servers never leave them out. */
  promptsOmitted: Schema.optional(Schema.Literal(true)),
  claims: Schema.Array(MissionClaimHere),
});
export type MissionsSnapshot = typeof MissionsSnapshot.Type;

export const MissionsSubscribeInput = Schema.Struct({
  /** Leaves each Mission's prompt out of the list; its editor reads it with `missions.getPrompt`. */
  omitPrompts: Schema.optional(Schema.Literal(true)),
});

/** The id goes into each member's tag, where a colon ends it. */
export const MissionId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/));
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
  /** A thread its first send just started in the mission, which has no work to brief its lead. */
  noBrief: Schema.optional(Schema.Literal(true)),
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

export const MISSION_PROMPT_MAX_LENGTH = 10_000;

export const normalizeMissionPrompt = (prompt: string) => prompt.trim();

/** Sets the Mission's own prompt for its lead. Empty text goes back to the Settings default. */
export const MissionSetPromptInput = Schema.Struct({
  missionId: Schema.String,
  prompt: Schema.String.check(Schema.isMaxLength(MISSION_PROMPT_MAX_LENGTH)),
});

export const MissionGetPromptInput = Schema.Struct({ missionId: Schema.String });
export const MissionPrompt = Schema.Struct({ prompt: Schema.String });

/**
 * What became of a thread a mission's lead started: it joined the lead's Mission, it waits on
 * its machine's answer, or it was refused and stays a thread of its own, for `reason`.
 */
export const MissionJoinOutcome = Schema.Struct({
  state: Schema.Literals(["joined", "pending", "refused"]),
  reason: Schema.optional(Schema.String),
});
export type MissionJoinOutcome = typeof MissionJoinOutcome.Type;

/**
 * The local user frees a thread on this machine from its Mission. With `missionId`, only from
 * that Mission: a thread that has moved to another stays where it is.
 */
export const MissionLeaveInput = Schema.Struct({
  threadId: ThreadId,
  missionId: Schema.optional(Schema.String),
});

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

const cut = (tag: string) => {
  let kept = "";
  for (const codePoint of tag) {
    if (kept.length + codePoint.length > THREAD_TAG_MAX_LENGTH) break;
    kept += codePoint;
  }
  return kept.trimEnd();
};

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

export const isMissionTag = (tag: string) =>
  tag.startsWith(MISSION_TAG_PREFIX) || tag.startsWith(MISSION_WAS_TAG_PREFIX);
