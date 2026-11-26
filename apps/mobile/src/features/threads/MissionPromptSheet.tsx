import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { blockLabel } from "@t3tools/client-runtime/missions";
import { type EnvironmentId, MISSION_PROMPT_MAX_LENGTH } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useMissionHosts } from "../../state/missions";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent } from "../pull-requests/PullRequestSheetContent";
import { missionPromptForm } from "./missionPrompt.logic";
import { reportMissionFailure } from "./useMissionActions";

export type MissionPromptParams = {
  readonly environmentId: EnvironmentId;
  readonly missionId: string;
};

export function MissionPromptSheet({ route }: StaticScreenProps<MissionPromptParams>) {
  const { environmentId, missionId } = route.params;
  const gt = useGT();
  const resolve = useMessages();
  const navigation = useNavigation();
  const snapshot = useMissionHosts().find((host) => host.environmentId === environmentId)?.snapshot;
  const mission = snapshot?.missions.find((candidate) => candidate.missionId === missionId);
  const promptsOmitted = snapshot?.promptsOmitted === true;
  const read = useEnvironmentQuery(
    promptsOmitted
      ? serverEnvironment.missionPrompt({ environmentId, input: { missionId } })
      : null,
  );
  const canSave = useAtomValue(serverEnvironment.setMissionPrompt.permissionAtom(environmentId));
  const setPrompt = useAtomCommand(serverEnvironment.setMissionPrompt, "mission set prompt");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const form = missionPromptForm({
    promptsOmitted,
    listed: mission?.prompt,
    read: read.data?.prompt ?? null,
    draft,
    canSave,
  });
  const save = async () => {
    if (!form.changed || form.next === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await setPrompt({ environmentId, input: { missionId, prompt: form.next } });
    inFlight.current = false;
    setBusy(false);
    reportMissionFailure(gt("Could not save the mission prompt"), result);
    if (result._tag === "Success") navigation.goBack();
  };
  return (
    <PullRequestSheetContent
      busy={busy}
      title={gt("Mission prompt")}
      subtitle={mission?.name ?? ""}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? gt("Saving…") : gt("Save")}
          loading={busy}
          disabled={!form.changed}
          onPress={() => void save()}
        />
      }
    >
      <Text className="text-sm text-foreground-muted">
        {(promptsOmitted ? read.error : null) ??
          gt(
            'The lead of "{mission}" follows this on every turn. Leave it empty to use the default from Settings.',
            { mission: mission?.name ?? "" },
          )}
      </Text>
      <TextInput
        multiline
        editable={!busy && form.editable}
        autoFocus
        accessibilityLabel={gt("Mission prompt")}
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={MISSION_PROMPT_MAX_LENGTH}
        value={form.value}
        onChangeText={setDraft}
        className="min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {canSave ? null : (
        <Text className="text-xs text-foreground-muted">
          {blockLabel("not-allowed", "", resolve)}
        </Text>
      )}
    </PullRequestSheetContent>
  );
}
