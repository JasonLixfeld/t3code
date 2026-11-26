import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import {
  clearMissionDraft,
  markMissionDraft,
  missionDraftOf,
  moveMissionDraft,
} from "./missionDraftStore";

it("moves a draft's mission to the machine a project pick moved that draft to", () => {
  const draftId = DraftId.make("moved-mission-draft");
  const thread = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("draft") };
  const intent = {
    kind: "member",
    host: thread.environmentId,
    missionId: "ba9876543210",
    name: "Ship",
  } as const;
  markMissionDraft(draftId, { intent, thread });
  const moved = { environmentId: EnvironmentId.make("laptop"), threadId: thread.threadId };
  moveMissionDraft(draftId, draftId, moved);
  expect(missionDraftOf(draftId)).toMatchObject({ intent, thread: moved });
  clearMissionDraft(draftId);
});
