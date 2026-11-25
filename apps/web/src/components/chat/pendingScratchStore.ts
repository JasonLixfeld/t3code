import { create } from "zustand";

import type { DraftId } from "~/composerDraftStore";

/**
 * Drafts whose "No project" home is still opening. Until it settles the draft cannot send or
 * change its project or mission, so nothing waits across the reply.
 */
const usePendingScratch = create<{ readonly drafts: ReadonlySet<DraftId> }>(() => ({
  drafts: new Set(),
}));

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
