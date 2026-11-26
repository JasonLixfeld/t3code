import {
  MISSION_SLOT,
  PROJECT_SLOT,
  splitDraftHeroSentence,
} from "@t3tools/client-runtime/draft-hero-sentence";
import type { MissionDraftIntent, MissionHost } from "@t3tools/client-runtime/missions";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";

export type DraftMissionKind = "none" | "member" | "new" | "lead";

export interface DraftMissionOption {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly intent: MissionDraftIntent | null;
}

export interface DraftMissionChoice {
  readonly kind: DraftMissionKind;
  readonly word: string;
  readonly label: string;
  readonly selected: string;
  /** A lead or a new mission cannot join another, so its only choice is to drop the mark. */
  readonly fixed: boolean;
  readonly options: ReadonlyArray<DraftMissionOption>;
}

const NO_MISSION = "none";
const NEW_MISSION = "new";

export function draftMissionChoice(
  input: {
    readonly enabled: boolean;
    readonly hosts: ReadonlyArray<MissionHost>;
    readonly startMachines: ReadonlySet<EnvironmentId>;
    readonly intent: MissionDraftIntent | undefined;
    readonly environmentId: EnvironmentId | null;
  },
  resolve: MessageResolver,
): DraftMissionChoice | null {
  const { intent, environmentId } = input;
  if (!input.enabled || environmentId === null) return null;
  const writable = input.startMachines.has(environmentId);
  if (!writable && intent === undefined) return null;
  if (intent?.kind === "new" || intent?.kind === "lead") {
    return {
      kind: intent.kind,
      word: intent.kind === "new" ? resolve(msg("a new mission")) : intent.name,
      label:
        intent.kind === "new"
          ? resolve(msg("New mission"))
          : resolve(msg("New lead for {mission}", { mission: intent.name })),
      selected: NO_MISSION,
      fixed: true,
      options: [
        {
          id: NO_MISSION,
          label: resolve(msg("Send as a plain thread")),
          disabled: false,
          intent: null,
        },
      ],
    };
  }
  const missionsOn = (host: EnvironmentId) =>
    input.hosts.find((candidate) => candidate.environmentId === host)?.snapshot.missions ?? [];
  const member = (host: EnvironmentId, mission: { missionId: string; name: string }) => ({
    id: `${host}:${mission.missionId}`,
    label: mission.name,
    disabled: !writable,
    intent: { kind: "member" as const, host, missionId: mission.missionId, name: mission.name },
  });
  const options: Array<DraftMissionOption> = [
    {
      id: NO_MISSION,
      label: resolve(msg("None", { $context: "no mission" })),
      disabled: false,
      intent: null,
    },
    ...missionsOn(environmentId).map((mission) => member(environmentId, mission)),
  ];
  const joining = intent === undefined ? NO_MISSION : `${intent.host}:${intent.missionId}`;
  if (intent !== undefined && !options.some((option) => option.id === joining)) {
    const mission = missionsOn(intent.host).find(
      (candidate) => candidate.missionId === intent.missionId,
    );
    options.push(
      mission === undefined
        ? { id: joining, label: resolve(msg("Unavailable mission")), disabled: true, intent: null }
        : member(intent.host, mission),
    );
  }
  options.push({
    id: NEW_MISSION,
    label: resolve(msg("New mission (this thread leads)")),
    disabled: !writable,
    intent: { kind: "new" },
  });
  const word = options.find((option) => option.id === joining)?.label ?? "";
  return {
    kind: intent === undefined ? "none" : "member",
    word,
    label:
      intent === undefined
        ? resolve(msg("Add to a mission"))
        : resolve(msg("Mission: {mission}", { mission: word })),
    selected: joining,
    fixed: false,
    options,
  };
}

type DraftHeroWord =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "project" | "mission"; readonly glue: string };

export type DraftHeroToken = DraftHeroWord & { readonly key: string };

const words = (text: string) => text.match(/\s*\S+\s*/g) ?? [];

function choiceThenWords(kind: "project" | "mission", text: string): DraftHeroWord[] {
  const [first = "", ...rest] = words(text);
  const glued = first.length > 0 && !/^\s/.test(first);
  return [
    { kind, glue: glued ? first : "" },
    ...(glued ? rest : [first, ...rest])
      .filter((word) => word.length > 0)
      .map((word) => ({ kind: "text" as const, text: word })),
  ];
}

export function draftHeroTokens(
  input: { readonly scratch: boolean; readonly mission: Exclude<DraftMissionKind, "none"> },
  resolve: MessageResolver,
): ReadonlyArray<DraftHeroToken> {
  const slots = { project: PROJECT_SLOT, mission: MISSION_SLOT };
  const sentence = input.scratch
    ? input.mission === "member"
      ? resolve(msg("What should we work on in mission {mission}?", slots))
      : input.mission === "new"
        ? resolve(msg("What should we work on in {mission}?", slots))
        : resolve(msg("What should we work on as the new lead for {mission}?", slots))
    : input.mission === "member"
      ? resolve(msg("What should we build in {project}, in mission {mission}?", slots))
      : input.mission === "new"
        ? resolve(msg("What should we build in {project}, in {mission}?", slots))
        : resolve(msg("What should we build in {project}, as the new lead for {mission}?", slots));
  const { beforeProject, beforeMission, afterMission } = splitDraftHeroSentence(sentence);
  const asText = (text: string) =>
    words(text).map((word) => ({ kind: "text" as const, text: word }));
  const sequence: ReadonlyArray<DraftHeroWord> = input.scratch
    ? [
        ...asText(beforeProject),
        ...asText(beforeMission),
        ...choiceThenWords("mission", afterMission),
      ]
    : [
        ...asText(beforeProject),
        ...choiceThenWords("project", beforeMission),
        ...choiceThenWords("mission", afterMission),
      ];
  const tokens: Array<DraftHeroToken> = [];
  let offset = 0;
  for (const word of sequence) {
    tokens.push({ ...word, key: `${word.kind}:${offset}` });
    offset += word.kind === "text" ? word.text.length : 1 + word.glue.length;
  }
  return tokens;
}
