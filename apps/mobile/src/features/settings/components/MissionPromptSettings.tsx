import { AuthOrchestrationOperateScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";

import { Button } from "../../../components/ui/Button";
import { AppTextInput } from "../../../components/ui/AppText";
import { readMissionAdvertisers } from "../../../state/missions";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { SettingsSection } from "./SettingsSection";

export function MissionPromptSettings() {
  const gt = useGT();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const environments = availableTargets.filter(
    (target) => target.serverConfig.environment.capabilities.missions === true,
  );
  const targets = resolveMobileSettingsTargets(environments, null);
  const settingsWritable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const writeSettings = useSettingsWriter();
  const saved = uniformMobileSetting(targets, "missionDefaultPrompt");
  const canOperate =
    environments.length > 0 &&
    environments.every(
      (target) => settingsWritable.has(target.environmentId) && operable.has(target.environmentId),
    ) &&
    managedSettingReason(targets, ["missionDefaultPrompt"]) === undefined;
  const save = (missionDefaultPrompt: string) =>
    void writeSettings(
      targets,
      planMobileScopedSettingsPatch(targets, false, { missionDefaultPrompt }),
    );
  const editKey = JSON.stringify([environments.map((target) => target.environmentId), saved]);
  // Each change of servers or saved prompt starts a new generation, so an edit never outlives one.
  const [editGeneration, setEditGeneration] = useState({ key: editKey, count: 0 });
  if (editGeneration.key !== editKey) {
    setEditGeneration({ key: editKey, count: editGeneration.count + 1 });
  }
  const generation = editGeneration.count;
  const draft = useRef<{ text: string; generation: number } | null>(null);
  const stillServesMissions = () => {
    const live = readMissionAdvertisers();
    return (
      live.length === environments.length &&
      environments.every((target) => live.includes(target.environmentId))
    );
  };
  const saveDraft = () => {
    const typed = draft.current;
    draft.current = null;
    if (typed === null || typed.generation !== generation || !stillServesMissions()) return;
    const value = typed.text.trim();
    if (saved === null || value !== saved) save(value);
  };
  // Android Back hides the keyboard without ending editing, so leaving the page saves too.
  const saveOnLeave = useEffectEvent(saveDraft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent prompt draft to server settings when the page unmounts
  useEffect(() => () => saveOnLeave(), []);
  if (targets.length === 0) return null;

  return (
    <View className="gap-3">
      <SettingsSection
        title={gt("Mission prompt")}
        footer={gt(
          "What every mission's lead thread follows on each turn, unless its mission has its own prompt.",
        )}
      >
        <View className="px-4 py-3">
          <AppTextInput
            key={generation}
            accessibilityLabel={gt("Mission prompt")}
            onChangeText={(text) => {
              draft.current = { text, generation };
            }}
            defaultValue={saved ?? ""}
            placeholder={
              saved === null
                ? gt("Mixed. Enter a prompt to apply to all selected targets.")
                : gt("Check each member's work before you call the mission done.")
            }
            editable={canOperate}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={saveDraft}
          />
        </View>
      </SettingsSection>
      {canOperate && saved !== "" ? (
        <Button
          label={gt("Reset mission prompt to default")}
          tone="text"
          onPress={() => {
            draft.current = null;
            save("");
          }}
        />
      ) : null}
    </View>
  );
}
