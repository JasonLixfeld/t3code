import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { clearMissionDraftIf, useMissionDraft } from "../../state/mission-drafts";
import { useMissionsTurnedOff } from "../../state/missions";

export function MissionDraftNotice(props: { readonly thread: ScopedThreadRef }) {
  const gt = useGT();
  const draft = useMissionDraft(props.thread);
  const turnedOff = useMissionsTurnedOff();
  if (draft === undefined || turnedOff) return null;
  const { intent } = draft;
  const failed = draft.step === "failed";
  const message = failed
    ? intent.kind === "new"
      ? gt("Could not start the mission")
      : intent.kind === "member"
        ? gt("Could not add this thread to the mission")
        : gt("Could not make this thread the lead")
    : intent.kind === "new"
      ? gt("Sending starts a new mission led by this thread")
      : intent.kind === "member"
        ? gt('Sending adds this thread to "{mission}"', { mission: intent.name })
        : gt('Sending makes this thread the lead of "{mission}"', { mission: intent.name });
  return (
    <View className="px-4 pb-3">
      <Notice
        message={message}
        icon={failed ? "exclamationmark.circle" : "info.circle"}
        iconTone={failed ? "danger" : "default"}
        floating
        {...(draft.step === "trying"
          ? {}
          : {
              onDismiss: () => clearMissionDraftIf(props.thread, draft),
              dismissLabel: failed ? gt("Dismiss") : gt("Send as a plain thread"),
            })}
      />
    </View>
  );
}
