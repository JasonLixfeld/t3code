import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  adoptMissionDraft,
  clearMissionDraft,
  draftMissionTarget,
  markMissionDraft,
  missionDraftOf,
  settleMissionDraftAttempt,
  startMissionDraftAttempt,
} from "./mission-drafts";

const thread = { environmentId: EnvironmentId.make("env-desk"), threadId: ThreadId.make("t1") };
const member = {
  kind: "member" as const,
  host: thread.environmentId,
  missionId: "m1",
  name: "Ship v2",
};

describe("mission drafts", () => {
  it("keeps a saved draft's mark on that draft when the route switches to another saved draft", () => {
    const draftA = draftMissionTarget("new-task:a", "route:a");
    markMissionDraft(draftA, member, () => "m-new");

    expect(missionDraftOf(draftMissionTarget(null, "route:b"))).toBeUndefined();
    expect(missionDraftOf(draftMissionTarget("new-task:b", "route:b"))).toBeUndefined();
    expect(missionDraftOf(draftMissionTarget("new-task:a", "route:reopened"))?.intent).toEqual(
      member,
    );

    clearMissionDraft({ draftId: "new-task:a" });
    expect(missionDraftOf(draftA)).toBeUndefined();
  });

  it("adopts only the exact mark the send checked", () => {
    const draft = { draftId: "new-task:send" };
    markMissionDraft(draft, member, () => "m-new");
    const checked = missionDraftOf(draft);
    markMissionDraft(draft, { kind: "new" }, () => "m-other");
    expect(checked !== undefined && adoptMissionDraft(draft, checked, thread)).toBe(false);
    expect(missionDraftOf(thread)).toBeUndefined();

    const current = missionDraftOf(draft);
    expect(current !== undefined && adoptMissionDraft(draft, current, thread)).toBe(true);
    expect(missionDraftOf(draft)).toBeUndefined();
    expect(missionDraftOf(thread)?.intent).toEqual({ kind: "new" });
    clearMissionDraft(thread);
  });

  it("applies a retry or an outcome only to the attempt that produced it", () => {
    markMissionDraft(thread, member, () => "m-new");
    const first = startMissionDraftAttempt(thread);
    settleMissionDraftAttempt(thread, first, "failed");
    settleMissionDraftAttempt(thread, first, "retry");
    const second = startMissionDraftAttempt(thread);

    expect(settleMissionDraftAttempt(thread, first, "done")).toBe(false);
    expect(settleMissionDraftAttempt(thread, first, "retry")).toBe(false);
    expect(missionDraftOf(thread)).toMatchObject({ step: "trying", attempt: second });

    expect(settleMissionDraftAttempt(thread, second, "failed")).toBe(true);
    settleMissionDraftAttempt(thread, second, "retry");
    expect(missionDraftOf(thread)?.step).toBe("waiting");
    settleMissionDraftAttempt(thread, second, "done");
    expect(missionDraftOf(thread)).toBeUndefined();
  });
});
