import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  clearMissionDraft,
  markMissionDraft,
  useMissionDrafts,
} from "../sidebar/missionDraftStore";
import { useMissionHosts } from "../sidebar/MissionsSection";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";

const NO_MISSION = "";

interface MissionItem {
  readonly value: string;
  readonly label: string;
}

/**
 * Which Mission on the draft's machine its thread joins once sent, or none. A draft that starts or
 * leads a Mission already belongs to one, so it shows no choice.
 */
export function DraftMissionSelect(props: {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { draftId, environmentId } = props;
  const hosts = useMissionHosts();
  const marked = useMissionDrafts((state) => state.drafts.get(draftId));
  const threadId = useComposerDraftStore(
    (store) => store.getDraftSession(draftId)?.threadId ?? null,
  );
  const missionOn = (host: EnvironmentId) =>
    hosts.find((candidate) => candidate.environmentId === host)?.snapshot.missions ?? [];
  // The Mission this draft joins, wherever it lives: New thread in this mission can mark it to
  // join one on a machine that links to this one.
  const target =
    marked?.intent.kind === "member"
      ? missionOn(marked.intent.host).find(
          (mission) =>
            marked.intent.kind === "member" && mission.missionId === marked.intent.missionId,
        )
      : undefined;
  const here = missionOn(environmentId);
  const missions =
    target === undefined || here.some((mission) => mission.missionId === target.missionId)
      ? here
      : [target, ...here];
  if (missions.length === 0 || threadId === null) return null;
  if (marked !== undefined && marked.intent.kind !== "member") return null;
  const items: ReadonlyArray<MissionItem> = [
    { value: NO_MISSION, label: gt("None", { $context: "no mission" }) },
    ...missions.map((mission) => ({ value: mission.missionId, label: mission.name })),
  ];
  const joining = marked?.intent.kind === "member" ? marked.intent.missionId : NO_MISSION;
  const selected = items.find((item) => item.value === joining) ?? items[0]!;
  return (
    <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm text-muted-foreground">
      <T>Mission</T>
      <Menu>
        <MenuTrigger
          render={<InlineButton tone="picker" />}
          aria-label={gt("Mission")}
          data-draft-mission-trigger=""
          className="pointer-events-auto min-w-0 max-w-full align-baseline"
        >
          <DraftProjectName value={selected.label} singleLine />
        </MenuTrigger>
        <MenuPopup align="center" className="w-64">
          <MenuRadioGroup
            value={joining}
            onValueChange={(value) => {
              const mission = missions.find((candidate) => candidate.missionId === value);
              if (mission === undefined) return clearMissionDraft(draftId);
              markMissionDraft(draftId, {
                intent: {
                  kind: "member",
                  host:
                    mission === target && marked?.intent.kind === "member"
                      ? marked.intent.host
                      : environmentId,
                  missionId: mission.missionId,
                  name: mission.name,
                },
                thread: { environmentId, threadId },
              });
            }}
          >
            {items.map((item) => (
              <MenuRadioItem key={item.value} value={item.value} closeOnClick>
                <span className="min-w-0 truncate">{item.label}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </p>
  );
}
