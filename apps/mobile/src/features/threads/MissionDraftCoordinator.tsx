import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { claimHere } from "@t3tools/client-runtime/missions";
import { type ScopedThreadRef, threadHasMessages } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent } from "react";

import { useThreadShell } from "../../state/entities";
import {
  clearMissionDraft,
  type MissionDraft,
  missionDraftsAtom,
  setMissionDraftStep,
} from "../../state/mission-drafts";
import { useMissionHosts } from "../../state/missions";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportLeadOutcome, reportMissionFailure } from "./useMissionActions";

// The shell lists a thread deleted on any device until its next full snapshot.
const threadRemovedAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ref = parseScopedThreadKey(key);
    return (
      ref !== null &&
      get(environmentShell.stateValueAtom(ref.environmentId)).removedAt.has(ref.threadId)
    );
  }).pipe(Atom.withLabel(`mobile-mission-draft-thread-removed:${key}`)),
);

function MissionDraftWatch(props: {
  readonly draft: MissionDraft;
  readonly thread: ScopedThreadRef;
}) {
  const { draft, thread } = props;
  const gt = useGT();
  const shell = useThreadShell(thread);
  const hosts = useMissionHosts();
  const createMission = useAtomCommand(serverEnvironment.createMission, "mission create");
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  const addMember = useAtomCommand(serverEnvironment.addMissionMember, "mission add member");
  const removed = useAtomValue(threadRemovedAtom(scopedThreadKey(thread)));
  const sent = shell !== null && threadHasMessages(shell);
  const { intent } = draft;
  const done =
    removed ||
    shell?.archivedAt != null ||
    claimHere({ environmentId: thread.environmentId, id: thread.threadId }, hosts) !== undefined ||
    (intent.kind !== "new" &&
      hosts.some(
        (host) =>
          host.environmentId === intent.host &&
          !host.snapshot.missions.some((mission) => mission.missionId === draft.missionId),
      ));
  const retry = () => setMissionDraftStep(thread, "waiting");
  const start = useEffectEvent(async () => {
    setMissionDraftStep(thread, "trying");
    if (intent.kind === "lead") {
      const outcome = reportLeadOutcome(
        await setLead({
          environmentId: intent.host,
          input: { missionId: draft.missionId, lead: thread, expectedLead: intent.expectedLead },
        }),
        retry,
      );
      if (outcome === "failed") setMissionDraftStep(thread, "failed");
      else clearMissionDraft(thread);
      return;
    }
    const [title, result] =
      intent.kind === "member"
        ? [
            gt("Could not add this thread to the mission"),
            await addMember({
              environmentId: intent.host,
              input: { missionId: draft.missionId, member: thread, noBrief: true },
            }),
          ]
        : [
            gt("Could not start the mission"),
            await createMission({
              environmentId: thread.environmentId,
              input: { missionId: draft.missionId, leadThreadId: thread.threadId },
            }),
          ];
    if (result._tag === "Success") return clearMissionDraft(thread);
    setMissionDraftStep(thread, "failed");
    reportMissionFailure(title, result, retry);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts, joins or leads the mission on the server once the thread's first message lands, and again after Try again
  useEffect(() => {
    if (draft.step !== "waiting") return;
    if (done) clearMissionDraft(thread);
    else if (sent) void start();
  }, [draft.step, done, sent, thread]);
  return null;
}

export function MissionDraftCoordinator() {
  const drafts = useAtomValue(missionDraftsAtom);
  return [...drafts].flatMap(([key, draft]) =>
    draft.thread === null
      ? []
      : [<MissionDraftWatch key={key} draft={draft} thread={draft.thread} />],
  );
}
