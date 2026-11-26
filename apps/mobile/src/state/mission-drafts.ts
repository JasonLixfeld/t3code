import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type MissionDraftIntent, newMissionId } from "@t3tools/client-runtime/missions";
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

export const missionDraftsAtom = Atom.make<ReadonlyMap<string, MissionDraft>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-mission-drafts"),
);

const requestKey = (requestId: string) => `request:${requestId}`;

function update(change: (drafts: Map<string, MissionDraft>) => void) {
  const next = new Map(appAtomRegistry.get(missionDraftsAtom));
  change(next);
  appAtomRegistry.set(missionDraftsAtom, next);
}

export function markMissionDraft(
  target: ScopedThreadRef | { readonly requestId: string },
  intent: MissionDraftIntent,
) {
  const missionId = intent.kind === "new" ? newMissionId() : intent.missionId;
  const [key, thread] =
    "requestId" in target
      ? [requestKey(target.requestId), null]
      : [scopedThreadKey(target), target];
  update((drafts) => drafts.set(key, { intent, missionId, thread, step: "waiting" }));
}

export function adoptMissionDraft(requestId: string | undefined, thread: ScopedThreadRef) {
  if (requestId === undefined) return;
  update((drafts) => {
    const draft = drafts.get(requestKey(requestId));
    if (draft === undefined) return;
    drafts.delete(requestKey(requestId));
    drafts.set(scopedThreadKey(thread), { ...draft, thread });
  });
}

export const missionDraftOf = (thread: ScopedThreadRef) =>
  appAtomRegistry.get(missionDraftsAtom).get(scopedThreadKey(thread));

export function setMissionDraftStep(thread: ScopedThreadRef, step: MissionDraft["step"]) {
  update((drafts) => {
    const draft = drafts.get(scopedThreadKey(thread));
    if (draft !== undefined) drafts.set(scopedThreadKey(thread), { ...draft, step });
  });
}

export function clearMissionDraft(thread: ScopedThreadRef) {
  update((drafts) => drafts.delete(scopedThreadKey(thread)));
}
