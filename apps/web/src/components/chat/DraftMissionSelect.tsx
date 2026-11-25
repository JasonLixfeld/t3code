import type { EnvironmentId, Mission } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import {
  clearMissionDraft,
  markMissionDraft,
  useMissionDrafts,
} from "../sidebar/missionDraftStore";
import { useMissionHosts } from "../sidebar/MissionsSection";
import { missionDraftMachines } from "../sidebar/missions.logic";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SelectButton } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftProjectName } from "./DraftProjectName";

const NO_MISSION = "";
const NEW_MISSION = "new";

interface MissionItem {
  readonly value: string;
  readonly label: string;
  readonly host?: EnvironmentId;
  readonly mission?: Mission;
}

/** The machines a Mission draft's project can be on, or null when any will do. */
export function useDraftProjectMachines(draftId: DraftId | null) {
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const hosts = useMissionHosts();
  const marked = useMissionDrafts((state) =>
    draftId === null ? undefined : state.drafts.get(draftId),
  );
  if (marked === undefined) return null;
  const pinned = new Set([marked.thread.environmentId]);
  // With Missions off no machine lists its links, so the draft keeps to the machine it is on.
  return enabled ? (missionDraftMachines(marked.intent, hosts) ?? pinned) : pinned;
}

/**
 * Which Mission on the draft's machine its thread joins once sent, or none, or a new one it leads.
 * A draft that starts or leads a Mission already belongs to one, so its choice is fixed.
 */
export function DraftMissionSelect(props: {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { draftId, environmentId } = props;
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const hosts = useMissionHosts();
  const marked = useMissionDrafts((state) => state.drafts.get(draftId));
  const threadId = useComposerDraftStore(
    (store) => store.getDraftSession(draftId)?.threadId ?? null,
  );
  if (!enabled || threadId === null) return null;
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
  const fixed =
    marked?.intent.kind === "new"
      ? gt("New mission")
      : marked?.intent.kind === "lead"
        ? gt("New lead for {mission}", { mission: marked.intent.name })
        : null;
  const selected = items.find((item) => item.value === joining) ?? items[0]!;
  const shown = fixed ?? selected.label;
  const trigger = (
    <SelectButton
      className="pointer-events-auto w-auto min-w-0 max-w-72"
      aria-label={gt("Mission: {mission}", { mission: shown })}
      data-draft-mission-trigger=""
      // Fixed, it stays focusable; its disabled look passes the pointer to the tooltip's wrapper.
      {...(fixed === null ? {} : { "aria-disabled": true, "data-disabled": "" })}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground text-xs">
          <T>Mission</T>
        </span>
        <DraftProjectName value={shown} singleLine />
      </span>
    </SelectButton>
  );
  // A draft that leads its Mission has no other choice, so its trigger only says why.
  if (fixed !== null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="pointer-events-auto inline-flex min-w-0" />}>
          {trigger}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <T>
            This thread leads its mission, so it cannot join another. Send it as a plain thread to
            undo this.
          </T>
        </TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={trigger} />
      <MenuPopup align="center" className="w-64">
        <MenuRadioGroup
          value={joining}
          onValueChange={(value) => {
            const thread = { environmentId, threadId };
            if (value === NEW_MISSION) {
              return markMissionDraft(draftId, { intent: { kind: "new" }, thread });
            }
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
              thread,
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
          <MenuSeparator />
          <MenuRadioItem value={NEW_MISSION} closeOnClick>
            <T>New mission (this thread leads)</T>
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
