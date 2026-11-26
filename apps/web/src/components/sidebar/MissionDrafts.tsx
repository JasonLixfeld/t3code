import { threadHasMessages } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";
import { InfoIcon } from "lucide-react";
import { useEffect } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  clearMissionDraft,
  type MissionDraft,
  setMissionDraftStep,
  useMissionDrafts,
} from "./missionDraftStore";
import { reportFailure, reportLeadOutcome, useMissionHosts } from "./MissionsSection";

/** The composer's line for a draft that starts, leads or joins a Mission, with a way to undo it. */
export function useMissionDraftBanner(
  draftId: DraftId | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const resolve = useMessages();
  const draft = useMissionDrafts((state) =>
    draftId === null ? undefined : state.drafts.get(draftId),
  );
  if (draftId === null || draft === undefined) return [];
  return [
    {
      id: "mission-draft",
      variant: "info",
      icon: <InfoIcon />,
      title:
        draft.intent.kind === "new"
          ? resolve(msg("Sending starts a new mission led by this thread"))
          : draft.step === "held"
            ? resolve(msg("This thread will not join a mission unless you pick one."))
            : draft.intent.kind === "member"
              ? resolve(
                  msg('Sending adds this thread to "{mission}"', { mission: draft.intent.name }),
                )
              : resolve(
                  msg('Sending makes this thread the lead of "{mission}"', {
                    mission: draft.intent.name,
                  }),
                ),
      description: resolve(msg("It stays on this machine and sends to one model.")),
      dismissLabel: resolve(msg("Send as a plain thread")),
      onDismiss: () => clearMissionDraft(draftId),
    },
  ];
}

function MissionDraftWatch(props: { readonly draftId: DraftId; readonly draft: MissionDraft }) {
  const { draftId, draft } = props;
  const shell = useThreadShell(draft.thread);
  const createMission = useAtomCommand(serverEnvironment.createMission, "mission create");
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  const addMember = useAtomCommand(serverEnvironment.addMissionMember, "mission add member");
  // A Mission's lead needs a message, so this waits for the first one to land.
  const sent = shell !== null && threadHasMessages(shell);
  const retry = () => setMissionDraftStep(draftId, "waiting");
  const start = useStableCallback(async () => {
    setMissionDraftStep(draftId, "trying");
    if (draft.intent.kind === "lead") {
      const outcome = reportLeadOutcome(
        await setLead({
          environmentId: draft.intent.host,
          input: {
            missionId: draft.missionId,
            lead: draft.thread,
            expectedLead: draft.intent.expectedLead,
          },
        }),
        retry,
      );
      // A lead that changed first leaves this thread plain, with its message.
      if (outcome === "failed") setMissionDraftStep(draftId, "failed");
      else clearMissionDraft(draftId);
      return;
    }
    const [title, result] =
      draft.intent.kind === "member"
        ? [
            m(msg("Could not add this thread to the mission")),
            await addMember({
              environmentId: draft.intent.host,
              input: { missionId: draft.missionId, member: draft.thread, noBrief: true },
            }),
          ]
        : [
            m(msg("Could not start the mission")),
            await createMission({
              environmentId: draft.thread.environmentId,
              input: { missionId: draft.missionId, leadThreadId: draft.thread.threadId },
            }),
          ];
    // The draft keeps its Mission until the server has it.
    if (result._tag === "Success") return clearMissionDraft(draftId);
    setMissionDraftStep(draftId, "failed");
    reportFailure(title, result, retry);
  });
  // A Mission to join that its machine no longer lists holds the join until another pick.
  const hosts = useMissionHosts();
  const gone =
    draft.intent.kind === "member" &&
    hosts.some(
      (host) =>
        draft.intent.kind === "member" &&
        host.environmentId === draft.intent.host &&
        !host.snapshot.missions.some((mission) => mission.missionId === draft.missionId),
    );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts or relinks the Mission on the server once the draft's first message has landed, and again after the user's "Try again"
  useEffect(() => {
    if (draft.step !== "waiting") return;
    if (gone) setMissionDraftStep(draftId, "held");
    else if (sent) void start();
  }, [draft.step, draftId, gone, sent, start]);
  return null;
}

/** Mounted once: acts on each marked draft when it is sent. */
export function MissionDraftCoordinator() {
  const drafts = useMissionDrafts((state) => state.drafts);
  return [...drafts].map(([draftId, draft]) => (
    <MissionDraftWatch key={draftId} draftId={draftId} draft={draft} />
  ));
}
