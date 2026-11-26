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
  readonly step: "waiting" | "trying" | "failed";
  readonly attempt: number;
}

export type MissionDraftTarget =
  | ScopedThreadRef
  | { readonly requestId: string }
  | { readonly draftId: string };

export const missionDraftsAtom = Atom.make<ReadonlyMap<string, MissionDraft>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-mission-drafts"),
);

export const draftMissionTarget = (
  draftKey: string | null,
  requestId: string,
): MissionDraftTarget => (draftKey === null ? { requestId } : { draftId: draftKey });

const keyOf = (target: MissionDraftTarget) =>
  "requestId" in target
    ? `request:${target.requestId}`
    : "draftId" in target
      ? `draft:${target.draftId}`
      : scopedThreadKey(target);

function update(change: (drafts: Map<string, MissionDraft>) => void) {
  const next = new Map(appAtomRegistry.get(missionDraftsAtom));
  change(next);
  appAtomRegistry.set(missionDraftsAtom, next);
}

export const missionDraftOf = (target: MissionDraftTarget) =>
  appAtomRegistry.get(missionDraftsAtom).get(keyOf(target));

export function markMissionDraft(
  target: MissionDraftTarget,
  intent: MissionDraftIntent,
  newMissionId: () => string,
) {
  const missionId = intent.kind === "new" ? newMissionId() : intent.missionId;
  const thread = "threadId" in target ? target : null;
  update((drafts) =>
    drafts.set(keyOf(target), { intent, missionId, thread, step: "waiting", attempt: 0 }),
  );
}

export function moveMissionDraft(from: MissionDraftTarget, to: MissionDraftTarget) {
  const draft = missionDraftOf(from);
  if (draft === undefined || missionDraftOf(to) !== undefined) return;
  const thread = "threadId" in to ? to : null;
  update((drafts) => {
    drafts.delete(keyOf(from));
    drafts.set(keyOf(to), { ...draft, thread, step: "waiting" });
  });
}

export function adoptMissionDraft(
  target: MissionDraftTarget,
  expected: MissionDraft,
  thread: ScopedThreadRef,
): boolean {
  if (missionDraftOf(target) !== expected) return false;
  moveMissionDraft(target, thread);
  return true;
}

export function useMissionDraft(
  ...targets: ReadonlyArray<MissionDraftTarget | null>
): MissionDraft | undefined {
  const drafts = useAtomValue(missionDraftsAtom);
  for (const target of targets) {
    const draft = target === null ? undefined : drafts.get(keyOf(target));
    if (draft !== undefined) return draft;
  }
  return undefined;
}

let lastAttempt = 0;

export function startMissionDraftAttempt(thread: ScopedThreadRef): number {
  const attempt = ++lastAttempt;
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
): boolean {
  const draft = missionDraftOf(thread);
  if (draft?.attempt !== attempt || (outcome === "retry" && draft.step !== "failed")) return false;
  update((drafts) => {
    if (outcome === "done") drafts.delete(scopedThreadKey(thread));
    else
      drafts.set(scopedThreadKey(thread), {
        ...draft,
        step: outcome === "failed" ? "failed" : "waiting",
      });
  });
  return true;
}

export function clearMissionDraft(target: MissionDraftTarget) {
  update((drafts) => drafts.delete(keyOf(target)));
}
