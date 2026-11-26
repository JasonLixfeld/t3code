import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";
import { type MissionDraftIntent, newMissionId } from "./missions.logic";

export interface MissionDraft {
  readonly intent: MissionDraftIntent;
  readonly thread: ScopedThreadRef;
  readonly missionId: string;
  readonly step: "waiting" | "trying" | "failed" | "held";
}

export const useMissionDrafts = create<{ readonly drafts: ReadonlyMap<DraftId, MissionDraft> }>(
  () => ({ drafts: new Map() }),
);

const update = (change: (drafts: Map<DraftId, MissionDraft>) => void) =>
  useMissionDrafts.setState(({ drafts }) => {
    const next = new Map(drafts);
    change(next);
    return { drafts: next };
  });

export function markMissionDraft(draftId: DraftId, draft: Pick<MissionDraft, "intent" | "thread">) {
  const missionId = draft.intent.kind === "new" ? newMissionId() : draft.intent.missionId;
  update((drafts) => drafts.set(draftId, { ...draft, missionId, step: "waiting" }));
}

export function missionDraftOf(draftId: DraftId | null): MissionDraft | undefined {
  return draftId === null ? undefined : useMissionDrafts.getState().drafts.get(draftId);
}

function useMissionDraftMachine(draftId: DraftId | null): EnvironmentId | null {
  return useMissionDrafts((state) =>
    draftId === null ? null : (state.drafts.get(draftId)?.thread.environmentId ?? null),
  );
}

export function useMissionDraftPinned(draftId: DraftId | null): boolean {
  return useMissionDraftMachine(draftId) !== null;
}

export function isMissionDraft(draftId: DraftId | null): boolean {
  return missionDraftOf(draftId) !== undefined;
}

export function setMissionDraftStep(draftId: DraftId, step: MissionDraft["step"]) {
  update((drafts) => {
    const draft = drafts.get(draftId);
    if (draft !== undefined) drafts.set(draftId, { ...draft, step });
  });
}

export function moveMissionDraft(from: DraftId, to: DraftId, thread: ScopedThreadRef) {
  update((drafts) => {
    const draft = drafts.get(from);
    if (draft === undefined) return;
    drafts.delete(from);
    drafts.set(to, { ...draft, thread });
  });
}

export function clearMissionDraft(draftId: DraftId) {
  update((drafts) => drafts.delete(draftId));
}

export function restoreMissionDraft(draftId: DraftId, draft: MissionDraft) {
  update((drafts) => drafts.set(draftId, draft));
}
