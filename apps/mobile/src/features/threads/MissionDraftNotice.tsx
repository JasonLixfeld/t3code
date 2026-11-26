import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { clearMissionDraft, useMissionDraft } from "../../state/mission-drafts";

export function MissionDraftNotice(props: { readonly thread: ScopedThreadRef }) {
  const gt = useGT();
  const draft = useMissionDraft(null, props.thread);
  if (draft === undefined) return null;
  const { intent } = draft;
  return (
    <View className="px-4 pb-3">
      <Notice
        message={
          intent.kind === "new"
            ? gt("Sending starts a new mission led by this thread")
            : intent.kind === "member"
              ? gt('Sending adds this thread to "{mission}"', { mission: intent.name })
              : gt('Sending makes this thread the lead of "{mission}"', { mission: intent.name })
        }
        icon="info.circle"
        floating
        onDismiss={() => clearMissionDraft(props.thread)}
        dismissLabel={gt("Send as a plain thread")}
      />
    </View>
  );
}
