import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";
import { type MissionDraftIntent, newMissionId } from "./missions.logic";

export interface MissionDraft {
  readonly intent: MissionDraftIntent;
  /** The thread the draft becomes when it is sent, on the machine the draft is pinned to. */
  readonly thread: ScopedThreadRef;
  /** Every try uses this id, so a try whose answer was lost is not doubled. */
  readonly missionId: string;
  /**
   * `waiting` until the first message lands, which starts the one automatic try. After a
   * failure only the user's "Try again" sets it back to `waiting`. `held`: the Mission it joins
   * is gone from its machine's list, so nothing is sent until the user picks again.
   */
  readonly step: "waiting" | "trying" | "failed" | "held";
}

/**
 * Drafts that start or lead a Mission once sent. Nothing is made before the first send, so an
 * abandoned draft leaves nothing behind. Kept for this session only.
 */
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

/** The machine a Mission draft is pinned to: it starts its Mission there, or leads one there. */
export function useMissionDraftMachine(draftId: DraftId | null): EnvironmentId | null {
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

/** The Mission follows the user to another draft on the same machine, as a project pick makes. */
export function moveMissionDraft(from: DraftId, to: DraftId, thread: ScopedThreadRef) {
  update((drafts) => {
    const draft = drafts.get(from);
    if (draft === undefined || from === to) return;
    drafts.delete(from);
    drafts.set(to, { ...draft, thread });
  });
}

export function clearMissionDraft(draftId: DraftId) {
  update((drafts) => drafts.delete(draftId));
}
