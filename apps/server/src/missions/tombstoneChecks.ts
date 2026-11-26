import type { EnvironmentId } from "@t3tools/contracts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIRST_RETRY_MS = 15 * SECOND;
const LONGEST_RETRY_MS = 10 * MINUTE;
const AFTER_ANSWER_MS = [
  5 * MINUTE,
  HOUR,
  6 * HOUR,
  ...Array.from({ length: 14 }, (_, day) => (day + 1) * DAY),
];

export interface TombstoneCheck {
  readonly environmentId: EnvironmentId;
  readonly answeredAt: number | null;
  readonly retryMs: number;
  readonly nextAt: number;
}

export const newTombstoneCheck = (environmentId: EnvironmentId, now: number): TombstoneCheck => ({
  environmentId,
  answeredAt: null,
  retryMs: FIRST_RETRY_MS,
  nextAt: now,
});

const scheduledAfter = (answeredAt: number, now: number) => {
  const offset = AFTER_ANSWER_MS.find((after) => answeredAt + after > now);
  return offset === undefined ? null : answeredAt + offset;
};

export function afterAnswer(check: TombstoneCheck, now: number): TombstoneCheck | null {
  const answeredAt = check.answeredAt ?? now;
  const nextAt = scheduledAfter(answeredAt, now);
  return nextAt === null ? null : { ...check, answeredAt, nextAt };
}

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
