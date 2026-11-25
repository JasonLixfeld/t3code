import { create } from "zustand";

import type { DraftId } from "~/composerDraftStore";

/**
 * Drafts whose "No project" home is still opening. Until it settles the draft cannot send or
 * change its project or mission, so nothing waits across the reply.
 */
const usePendingScratch = create<{ readonly drafts: ReadonlySet<DraftId> }>(() => ({
  drafts: new Set(),
}));

/** How long the picker waits for the no-project home before it gives up and unlocks the draft. */
export const SCRATCH_REPLY_TIMEOUT_MS = 15_000;

export function isScratchPending(draftId: DraftId): boolean {
  return usePendingScratch.getState().drafts.has(draftId);
}

export function setScratchPending(draftId: DraftId, pending: boolean) {
  usePendingScratch.setState(({ drafts }) => {
    const next = new Set(drafts);
    if (pending) next.add(draftId);
    else next.delete(draftId);
    return { drafts: next };
  });
}

export function useScratchPending(draftId: DraftId | null): boolean {
  return usePendingScratch((state) => draftId !== null && state.drafts.has(draftId));
}
