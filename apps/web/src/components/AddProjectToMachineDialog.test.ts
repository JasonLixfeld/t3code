import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { expect, it, onTestFinished } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { draftMovingToClone } from "./AddProjectToMachineDialog";
import { clearMissionDraft, markMissionDraft } from "./sidebar/missionDraftStore";

it("moves the open draft to the clone, but leaves a mission draft on its machine", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const draftId = DraftId.make("draft-on-source");
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId);
  onTestFinished(() => useComposerDraftStore.getState().clearDraftThread(draftId));
  expect(draftMovingToClone(draftId, projectRef)).toBe(draftId);

  markMissionDraft(draftId, {
    intent: { kind: "new" },
    thread: { environmentId, threadId: ThreadId.make("mission-lead") },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  expect(draftMovingToClone(draftId, projectRef)).toBeNull();
});
