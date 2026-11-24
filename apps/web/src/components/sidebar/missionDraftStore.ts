import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";
import type { MissionDraftIntent } from "./missions.logic";

export interface MissionDraft {
  readonly intent: MissionDraftIntent;
  /** The thread the draft becomes when it is sent. */
  readonly thread: ScopedThreadRef;
}

/**
 * Drafts that start or lead a Mission once sent. Nothing is made before the first send, so an
 * abandoned draft leaves nothing behind. Kept for this session only.
 */
export const useMissionDrafts = create<{ readonly drafts: ReadonlyMap<DraftId, MissionDraft> }>(
  () => ({
    drafts: new Map(),
  }),
);

export function markMissionDraft(draftId: DraftId, draft: MissionDraft) {
  useMissionDrafts.setState(({ drafts }) => ({ drafts: new Map(drafts).set(draftId, draft) }));
}

/**
 * A Mission draft stays on the machine it was opened on, as one thread: it starts its Mission
 * there, or leads one that lives there.
 */
export function useMissionDraftPinned(draftId: DraftId | null): boolean {
  return useMissionDrafts((state) => draftId !== null && state.drafts.has(draftId));
}

export function isMissionDraft(draftId: DraftId | null): boolean {
  return draftId !== null && useMissionDrafts.getState().drafts.has(draftId);
}

export function clearMissionDraft(draftId: DraftId) {
  useMissionDrafts.setState(({ drafts }) => {
    const next = new Map(drafts);
    next.delete(draftId);
    return { drafts: next };
  });
}
