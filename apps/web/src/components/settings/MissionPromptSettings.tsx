import { useGT } from "gt-react";
import { useRef } from "react";

import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function MissionPromptSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["missionDefaultPrompt"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["missionDefaultPrompt"]}
      {...searchableSetting("mission-default-prompt")}
      description={gt(
        "What every mission's lead thread follows on each turn, unless its mission has its own prompt.",
      )}
      resetAction={
        mixed || settings.missionDefaultPrompt !== "" ? (
          <SettingResetButton
            ariaLabel={gt("Reset mission prompt to default")}
            onClick={() => updateSettings({ missionDefaultPrompt: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${settings.missionDefaultPrompt}`}
          aria-label={gt("Mission prompt")}
          onChange={() => {
            edited.current = true;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.missionDefaultPrompt}
          placeholder={
            mixed
              ? gt("Mixed. Enter a prompt to apply to all selected targets.")
              : gt("Check each member's work before you call the mission done.")
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.missionDefaultPrompt))
              updateSettings({ missionDefaultPrompt: value });
            edited.current = false;
          }}
        />
      </div>
    </SettingsRow>
  );
}
