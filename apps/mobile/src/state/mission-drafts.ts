import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MissionDraftIntent } from "@t3tools/client-runtime/missions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

export interface MissionDraft {
  readonly intent: MissionDraftIntent;
  readonly missionId: string;
  readonly thread: ScopedThreadRef | null;
  readonly draftKey: string | null;
  readonly step: "waiting" | "trying" | "failed";
  readonly attempt: number;
}

export type MissionDraftTarget = ScopedThreadRef | { readonly requestId: string };

export const missionDraftsAtom = Atom.make<ReadonlyMap<string, MissionDraft>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-mission-drafts"),
);

const REQUEST_PREFIX = "request:";
const requestKey = (requestId: string) => `${REQUEST_PREFIX}${requestId}`;
const keyOf = (target: MissionDraftTarget) =>
  "requestId" in target ? requestKey(target.requestId) : scopedThreadKey(target);

function update(change: (drafts: Map<string, MissionDraft>) => void) {
  const next = new Map(appAtomRegistry.get(missionDraftsAtom));
  change(next);
  appAtomRegistry.set(missionDraftsAtom, next);
}

export function markMissionDraft(
  target: MissionDraftTarget,
  intent: MissionDraftIntent,
  newMissionId: () => string,
) {
  const missionId = intent.kind === "new" ? newMissionId() : intent.missionId;
  const thread = "requestId" in target ? null : target;
  update((drafts) => {
    const draftKey = drafts.get(keyOf(target))?.draftKey ?? null;
    drafts.set(keyOf(target), { intent, missionId, thread, draftKey, step: "waiting", attempt: 0 });
  });
}

export function adoptMissionDraft(requestId: string, thread: ScopedThreadRef) {
  update((drafts) => {
    const draft = drafts.get(requestKey(requestId));
    if (draft === undefined) return;
    drafts.delete(requestKey(requestId));
    drafts.set(scopedThreadKey(thread), { ...draft, thread, draftKey: null });
  });
}

export function bindMissionDraft(requestId: string, draftKey: string) {
  const draft = missionDraftOf({ requestId });
  if (draft === undefined || draft.draftKey === draftKey) return;
  update((drafts) => drafts.set(requestKey(requestId), { ...draft, draftKey }));
}

const boundRequestId = (drafts: ReadonlyMap<string, MissionDraft>, draftKey: string) => {
  for (const [key, draft] of drafts) {
    if (draft.draftKey === draftKey && key.startsWith(REQUEST_PREFIX)) {
      return key.slice(REQUEST_PREFIX.length);
    }
  }
  return undefined;
};

export const missionDraftRequestIdOf = (draftKey: string) =>
  boundRequestId(appAtomRegistry.get(missionDraftsAtom), draftKey);

export function useMissionDraftRequestId(draftKey: string | null): string | undefined {
  const drafts = useAtomValue(missionDraftsAtom);
  return draftKey === null ? undefined : boundRequestId(drafts, draftKey);
}

export function clearSavedDraftMission(draftKey: string) {
  const requestId = missionDraftRequestIdOf(draftKey);
  if (requestId !== undefined) clearMissionDraft({ requestId });
}

export const missionDraftOf = (target: MissionDraftTarget) =>
  appAtomRegistry.get(missionDraftsAtom).get(keyOf(target));

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

export function startMissionDraftAttempt(thread: ScopedThreadRef): number {
  const attempt = (missionDraftOf(thread)?.attempt ?? 0) + 1;
  update((drafts) => {
    const draft = drafts.get(scopedThreadKey(thread));
    if (draft !== undefined)
      drafts.set(scopedThreadKey(thread), { ...draft, step: "trying", attempt });
  });
  return attempt;
}

export function settleMissionDraftAttempt(
  thread: ScopedThreadRef,
  attempt: number,
  outcome: "done" | "failed" | "retry",
) {
  const draft = missionDraftOf(thread);
  if (draft?.attempt !== attempt || (outcome === "retry" && draft.step !== "failed")) return;
  update((drafts) => {
    if (outcome === "done") drafts.delete(scopedThreadKey(thread));
    else
      drafts.set(scopedThreadKey(thread), {
        ...draft,
        step: outcome === "failed" ? "failed" : "waiting",
      });
  });
}

export function clearMissionDraft(target: MissionDraftTarget) {
  update((drafts) => drafts.delete(keyOf(target)));
}
