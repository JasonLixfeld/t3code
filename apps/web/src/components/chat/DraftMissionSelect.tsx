import type { EnvironmentId, Mission } from "@t3tools/contracts";
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
  readonly host?: EnvironmentId;
  readonly mission?: Mission;
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
  const keyOf = (host: EnvironmentId, missionId: string) => `${host}:${missionId}`;
  // Options are keyed by machine and id, so a Mission on a machine linked to this one, as New
  // thread in this mission picks, is told apart from one here.
  const items: Array<MissionItem> = [
    { value: NO_MISSION, label: gt("None", { $context: "no mission" }) },
    ...missionOn(environmentId).map((mission) => ({
      value: keyOf(environmentId, mission.missionId),
      label: mission.name,
      host: environmentId,
      mission,
    })),
  ];
  const joining =
    marked?.intent.kind === "member"
      ? keyOf(marked.intent.host, marked.intent.missionId)
      : NO_MISSION;
  if (marked?.intent.kind === "member" && !items.some((item) => item.value === joining)) {
    const { host, missionId } = marked.intent;
    const mission = missionOn(host).find((candidate) => candidate.missionId === missionId);
    // Gone from its machine's list, so nothing joins it until another pick.
    items.push(
      mission === undefined
        ? { value: joining, label: gt("Unavailable mission") }
        : { value: joining, label: mission.name, host, mission },
    );
  }
  if (items.length === 1 || threadId === null) return null;
  if (marked !== undefined && marked.intent.kind !== "member") return null;
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
              const item = items.find((candidate) => candidate.value === value);
              if (item?.mission === undefined || item.host === undefined) {
                return clearMissionDraft(draftId);
              }
              markMissionDraft(draftId, {
                intent: {
                  kind: "member",
                  host: item.host,
                  missionId: item.mission.missionId,
                  name: item.mission.name,
                },
                thread: { environmentId, threadId },
              });
            }}
          >
            {items.map((item) => (
              <MenuRadioItem
                key={item.value}
                value={item.value}
                disabled={item.value !== NO_MISSION && item.mission === undefined}
                closeOnClick
              >
                <span className="min-w-0 truncate">{item.label}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </p>
  );
}
