import type { EnvironmentId, Mission } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import type { ReactElement } from "react";

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
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftProjectName } from "./DraftProjectName";
import { useScratchPending } from "./pendingScratchStore";

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

export interface DraftMissionChoice {
  readonly kind: "none" | "member" | "new" | "lead";
  readonly word: ReactElement;
}

/**
 * Which Mission on the draft's machine its thread joins once sent, or none, or a new one it leads,
 * as a word for the draft's headline. A draft that starts or leads a Mission already belongs to
 * one, so its word is fixed.
 */
export function useDraftMissionChoice(
  draftId: DraftId | null,
  environmentId: EnvironmentId | null,
): DraftMissionChoice | null {
  const gt = useGT();
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const hosts = useMissionHosts();
  const marked = useMissionDrafts((state) =>
    draftId === null ? undefined : state.drafts.get(draftId),
  );
  const preparingScratch = useScratchPending(draftId);
  const threadId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.threadId ?? null),
  );
  if (!enabled || draftId === null || environmentId === null || threadId === null) return null;
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
  const kind = marked?.intent.kind ?? "none";
  const shown =
    marked?.intent.kind === "new"
      ? gt("a new mission")
      : marked?.intent.kind === "lead"
        ? marked.intent.name
        : (items.find((item) => item.value === joining) ?? items[0]!).label;
  const fixed = kind === "new" || kind === "lead";
  const trigger = (
    <InlineButton
      tone={kind === "none" ? "muted" : "picker"}
      className={`min-w-0 max-w-full align-baseline ${fixed ? "pointer-events-none" : "pointer-events-auto"}`}
      data-draft-mission-trigger=""
      {...(kind === "none" ? {} : { "aria-label": gt("Mission: {mission}", { mission: shown }) })}
      // Fixed, it stays focusable; the pointer passes through it to the tooltip's wrapper.
      {...(fixed ? { "aria-disabled": true } : {})}
    >
      {kind === "none" ? <T>Add to a mission</T> : <DraftProjectName value={shown} singleLine />}
    </InlineButton>
  );
  if (fixed) {
    return {
      kind,
      word: (
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
      ),
    };
  }
  return {
    kind,
    word: (
      <Menu>
        <MenuTrigger render={trigger} disabled={preparingScratch} />
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
    ),
  };
}
