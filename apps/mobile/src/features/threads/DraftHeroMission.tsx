import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { newMissionId } from "../../lib/uuid";
import { clearMissionDraft, markMissionDraft, useMissionDraft } from "../../state/mission-drafts";
import {
  useMissionHosts,
  useMissionPreferences,
  useMissionStartMachines,
} from "../../state/missions";
import {
  type DraftHeroToken,
  chosenDraftMissionOption,
  type DraftMissionChoice,
  draftMissionChoice,
} from "./draftMission.logic";

const HERO_TEXT = "text-2xl font-t3-medium tracking-tight text-foreground";

export function useDraftMission(input: {
  readonly requestId: string;
  readonly thread: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
}) {
  const resolve = useMessages();
  const { enabled } = useMissionPreferences();
  const hosts = useMissionHosts();
  const startMachines = useMissionStartMachines(hosts);
  const mark = useMissionDraft(input.requestId, input.thread);
  const choice = draftMissionChoice(
    { enabled, hosts, startMachines, intent: mark?.intent, environmentId: input.environmentId },
    resolve,
  );
  const choose = (id: string) => {
    const option = chosenDraftMissionOption(choice, id);
    if (option === undefined) return;
    const target = { requestId: input.requestId };
    if (option.intent === null) clearMissionDraft(target);
    else markMissionDraft(target, option.intent, newMissionId);
  };
  return { choice, choose };
}

export function DraftMissionMenu(props: {
  readonly choice: DraftMissionChoice;
  readonly disabled: boolean;
  readonly onChoose: (id: string) => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  if (props.disabled) return props.children;
  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.choice.label}
      title={
        props.choice.fixed
          ? gt(
              "This thread leads its mission, so it cannot join another. Send it as a plain thread to undo this.",
            )
          : undefined
      }
      actions={props.choice.options.map((option) => ({
        id: option.id,
        title: option.label,
        ...(option.id === props.choice.selected ? { state: "on" as const } : {}),
        ...(option.disabled ? { attributes: { disabled: true } } : {}),
      }))}
      onPressAction={({ nativeEvent }) => props.onChoose(nativeEvent.event)}
    >
      {props.children}
    </Menu>
  );
}

export function DraftMissionControl(props: {
  readonly choice: DraftMissionChoice;
  readonly disabled: boolean;
  readonly onChoose: (id: string) => void;
}) {
  return (
    <DraftMissionMenu {...props}>
      <ComposerInlineControl
        accessibilityLabel={props.choice.label}
        disabled={props.disabled}
        icon="folder.badge.plus"
        label={props.choice.label}
        static
      />
    </DraftMissionMenu>
  );
}

function ChoiceWord(props: { readonly label: string; readonly glue: string }) {
  return (
    <View className="min-w-0 max-w-full flex-row items-center">
      <View className="min-w-0 max-w-[250px] shrink border-b border-foreground-muted">
        <Text className={HERO_TEXT} numberOfLines={1}>
          {props.label}
        </Text>
      </View>
      {props.glue ? <Text className={HERO_TEXT}>{props.glue}</Text> : null}
    </View>
  );
}

export function DraftHeroSentence(props: {
  readonly tokens: ReadonlyArray<DraftHeroToken>;
  readonly projectLabel: string;
  readonly choice: DraftMissionChoice;
  readonly disabled: boolean;
  readonly onChooseProject: () => void;
  readonly onChooseMission: (id: string) => void;
}) {
  const gt = useGT();
  return (
    <View className="max-w-full flex-row flex-wrap items-center justify-center">
      {props.tokens.map((token) =>
        token.kind === "text" ? (
          <Text key={token.key} className={HERO_TEXT}>
            {token.text}
          </Text>
        ) : token.kind === "project" ? (
          <Pressable
            key={token.key}
            accessibilityHint={gt("Opens the project picker")}
            accessibilityLabel={gt("Project: {project}", { project: props.projectLabel })}
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={props.onChooseProject}
            className="min-w-0 max-w-full active:opacity-65"
          >
            <ChoiceWord label={props.projectLabel} glue={token.glue} />
          </Pressable>
        ) : (
          <DraftMissionMenu
            key={token.key}
            choice={props.choice}
            disabled={props.disabled}
            onChoose={props.onChooseMission}
          >
            <ChoiceWord label={props.choice.word} glue={token.glue} />
          </DraftMissionMenu>
        ),
      )}
    </View>
  );
}
