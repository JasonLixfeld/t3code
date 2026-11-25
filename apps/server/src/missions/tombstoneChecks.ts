import type { EnvironmentId } from "@t3tools/contracts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Until a machine answers once, it is asked again after this long, doubled each miss. */
const FIRST_RETRY_MS = 15 * SECOND;
const LONGEST_RETRY_MS = 10 * MINUTE;
/**
 * After its first clean answer, when a machine is asked again: a join still on its way can land
 * after that answer. Past the last, it is not asked for this reason any more.
 */
const AFTER_ANSWER_MS = [
  5 * MINUTE,
  HOUR,
  6 * HOUR,
  ...Array.from({ length: 14 }, (_, day) => (day + 1) * DAY),
];

/**
 * A machine a deleted Mission's claims may be on, and when to ask it next. A machine that has not
 * answered since the delete is asked with no end; its claims are released whenever it answers.
 */
export interface TombstoneCheck {
  readonly environmentId: EnvironmentId;
  /** Its first clean answer since the delete, in epoch milliseconds. */
  readonly answeredAt: number | null;
  /** How long until it is asked again after its next miss, before it has answered. */
  readonly retryMs: number;
  readonly nextAt: number;
}

export const newTombstoneCheck = (environmentId: EnvironmentId, now: number): TombstoneCheck => ({
  environmentId,
  answeredAt: null,
  retryMs: FIRST_RETRY_MS,
  nextAt: now,
});

/** The first check after `now` on the schedule after an answer, or null once it has run out. */
const scheduledAfter = (answeredAt: number, now: number) => {
  const offset = AFTER_ANSWER_MS.find((after) => answeredAt + after > now);
  return offset === undefined ? null : answeredAt + offset;
};

/** The machine answered: every list counts, whatever it was asked for. Null: stop asking. */
export function afterAnswer(check: TombstoneCheck, now: number): TombstoneCheck | null {
  const answeredAt = check.answeredAt ?? now;
  const nextAt = scheduledAfter(answeredAt, now);
  return nextAt === null ? null : { ...check, answeredAt, nextAt };
}

/** The machine did not answer. Before its first answer, each miss waits twice as long. */
export function afterMiss(check: TombstoneCheck, now: number): TombstoneCheck | null {
  if (check.answeredAt !== null) {
    const nextAt = scheduledAfter(check.answeredAt, now);
    return nextAt === null ? null : { ...check, nextAt };
  }
  return {
    ...check,
    nextAt: now + check.retryMs,
    retryMs: Math.min(check.retryMs * 2, LONGEST_RETRY_MS),
  };
}
