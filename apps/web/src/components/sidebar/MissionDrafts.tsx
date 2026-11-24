import { type ScopedThreadRef, threadHasMessages } from "@t3tools/contracts";
import { msg } from "gt-react";
import { InfoIcon } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";
import { m, type MessageResolver } from "../../i18n/messages";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import type { MissionDraftIntent } from "./missions.logic";
import { newMissionId, reportFailure } from "./MissionsSection";

interface MissionDraft {
  readonly intent: MissionDraftIntent;
  /** The thread the draft becomes when it is sent. */
  readonly thread: ScopedThreadRef;
}

/**
 * Drafts that start or lead a Mission once sent. Nothing is made before the first send, so an
 * abandoned draft leaves nothing behind. Kept for this session only.
 */
const useMissionDrafts = create<{ readonly drafts: ReadonlyMap<DraftId, MissionDraft> }>(() => ({
  drafts: new Map(),
}));

export function markMissionDraft(draftId: DraftId, draft: MissionDraft) {
  useMissionDrafts.setState(({ drafts }) => ({ drafts: new Map(drafts).set(draftId, draft) }));
}

function clearMissionDraft(draftId: DraftId) {
  useMissionDrafts.setState(({ drafts }) => {
    const next = new Map(drafts);
    next.delete(draftId);
    return { drafts: next };
  });
}

/** The composer's line for a draft that starts or leads a Mission, with a way to undo it. */
export function useMissionDraftBanner(
  draftId: DraftId | null,
  resolve: MessageResolver = m,
): ReadonlyArray<ComposerBannerStackItem> {
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
          ? resolve(msg("Sending starts a mission led by this thread"))
          : resolve(
              msg('Sending makes this thread the lead of "{mission}"', {
                mission: draft.intent.name,
              }),
            ),
      dismissLabel: resolve(msg("Send as a plain thread")),
      onDismiss: () => clearMissionDraft(draftId),
    },
  ];
}

function MissionDraftWatch(props: { readonly draftId: DraftId; readonly draft: MissionDraft }) {
  const shell = useThreadShell(props.draft.thread);
  const createMission = useAtomCommand(serverEnvironment.createMission, "mission create");
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  // A Mission's lead needs a message, so this waits for the first one to land.
  const sent = shell !== null && threadHasMessages(shell);
  const { draftId, draft } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts or relinks the Mission on the server once the draft's first message has landed there
  useEffect(() => {
    if (!sent) return;
    clearMissionDraft(draftId);
    void (async () => {
      if (draft.intent.kind === "new") {
        reportFailure(
          m(msg("Could not start the mission")),
          await createMission({
            environmentId: draft.thread.environmentId,
            input: { missionId: newMissionId(), leadThreadId: draft.thread.threadId },
          }),
        );
        return;
      }
      reportFailure(
        m(msg("Could not make this thread the lead")),
        await setLead({
          environmentId: draft.intent.host,
          input: { missionId: draft.intent.missionId, lead: draft.thread },
        }),
      );
    })();
  }, [createMission, draft, draftId, sent, setLead]);
  return null;
}

/** Mounted once: acts on each marked draft when it is sent. */
export function MissionDraftCoordinator() {
  const drafts = useMissionDrafts((state) => state.drafts);
  return [...drafts].map(([draftId, draft]) => (
    <MissionDraftWatch key={draftId} draftId={draftId} draft={draft} />
  ));
}
