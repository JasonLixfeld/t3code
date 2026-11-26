import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  adoptMissionDraft,
  bindMissionDraft,
  clearSavedDraftMission,
  markMissionDraft,
  missionDraftOf,
  missionDraftRequestIdOf,
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
  it("finds a saved draft's mark when the draft is reopened, and drops it when the draft is discarded", () => {
    markMissionDraft({ requestId: "route-1" }, { kind: "new" }, () => "m-new");
    bindMissionDraft("route-1", "draft-1");
    markMissionDraft({ requestId: "route-1" }, member, () => "m-new");

    const reopened = missionDraftRequestIdOf("draft-1");
    expect(reopened).toBe("route-1");
    expect(missionDraftOf({ requestId: reopened ?? "" })?.intent).toEqual(member);

    clearSavedDraftMission("draft-1");
    expect(missionDraftOf({ requestId: "route-1" })).toBeUndefined();
    expect(missionDraftRequestIdOf("draft-1")).toBeUndefined();
  });

  it("applies a retry or an outcome only to the attempt that produced it", () => {
    markMissionDraft({ requestId: "route-2" }, member, () => "m-new");
    bindMissionDraft("route-2", "draft-2");
    adoptMissionDraft("route-2", thread);
    expect(missionDraftRequestIdOf("draft-2")).toBeUndefined();

    const first = startMissionDraftAttempt(thread);
    settleMissionDraftAttempt(thread, first, "failed");
    settleMissionDraftAttempt(thread, first, "retry");
    const second = startMissionDraftAttempt(thread);

    settleMissionDraftAttempt(thread, first, "done");
    settleMissionDraftAttempt(thread, first, "retry");
    expect(missionDraftOf(thread)).toMatchObject({ step: "trying", attempt: second });

    settleMissionDraftAttempt(thread, second, "failed");
    expect(missionDraftOf(thread)?.step).toBe("failed");
    settleMissionDraftAttempt(thread, second, "retry");
    expect(missionDraftOf(thread)?.step).toBe("waiting");
    settleMissionDraftAttempt(thread, second, "done");
    expect(missionDraftOf(thread)).toBeUndefined();
  });
});
