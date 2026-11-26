import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MissionDraftIntent } from "@t3tools/client-runtime/missions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

export interface MissionDraft {
  readonly intent: MissionDraftIntent;
  readonly missionId: string;
  /** Null while a new-thread draft has not sent yet. */
  readonly thread: ScopedThreadRef | null;
  readonly step: "waiting" | "trying" | "failed";
}

/** A draft route's request, before its first send, or the thread it became. */
export type MissionDraftTarget = ScopedThreadRef | { readonly requestId: string };

export const missionDraftsAtom = Atom.make<ReadonlyMap<string, MissionDraft>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-mission-drafts"),
);

const requestKey = (requestId: string) => `request:${requestId}`;
const keyOf = (target: MissionDraftTarget) =>
  "requestId" in target ? requestKey(target.requestId) : scopedThreadKey(target);

function update(change: (drafts: Map<string, MissionDraft>) => void) {
  const next = new Map(appAtomRegistry.get(missionDraftsAtom));
  change(next);
  appAtomRegistry.set(missionDraftsAtom, next);
}

/** `newMissionId` comes from the caller, so this store stays out of expo-crypto's import graph. */
export function markMissionDraft(
  target: MissionDraftTarget,
  intent: MissionDraftIntent,
  newMissionId: () => string,
) {
  const missionId = intent.kind === "new" ? newMissionId() : intent.missionId;
  const thread = "requestId" in target ? null : target;
  update((drafts) => drafts.set(keyOf(target), { intent, missionId, thread, step: "waiting" }));
}

export function adoptMissionDraft(requestId: string, thread: ScopedThreadRef) {
  update((drafts) => {
    const draft = drafts.get(requestKey(requestId));
    if (draft === undefined) return;
    drafts.delete(requestKey(requestId));
    drafts.set(scopedThreadKey(thread), { ...draft, thread });
  });
}

export const missionDraftOf = (target: MissionDraftTarget) =>
  appAtomRegistry.get(missionDraftsAtom).get(keyOf(target));

/** The mark of a draft route: under its request before the first send, its thread after. */
export function useMissionDraft(
  requestId: string | null,
  thread: ScopedThreadRef | null,
): MissionDraft | undefined {
  const drafts = useAtomValue(missionDraftsAtom);
  return (
    (requestId === null ? undefined : drafts.get(requestKey(requestId))) ??
    (thread === null ? undefined : drafts.get(scopedThreadKey(thread)))
  );
}

export function setMissionDraftStep(thread: ScopedThreadRef, step: MissionDraft["step"]) {
  update((drafts) => {
    const draft = drafts.get(scopedThreadKey(thread));
    if (draft !== undefined) drafts.set(scopedThreadKey(thread), { ...draft, step });
  });
}

export function clearMissionDraft(target: MissionDraftTarget) {
  update((drafts) => drafts.delete(keyOf(target)));
}
