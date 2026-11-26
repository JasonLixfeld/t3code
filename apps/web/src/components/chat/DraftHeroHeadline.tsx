import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { T, useGT } from "gt-react";
import { FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { use, useEffect, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useClientSettings } from "~/hooks/useSettings";
import { seedDraftModelSelection } from "~/lib/seedDraftModelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
import { TriageDraftHero } from "./TriageDraftHero";
import { useDraftMissionChoice, useDraftProjectMachines } from "./DraftMissionSelect";
import { MISSION_SLOT, PROJECT_SLOT, splitDraftHeroSentence } from "./draftHeroSentence";
import { missionDraftOf, moveMissionDraft } from "../sidebar/missionDraftStore";
import { missionScratchHome } from "../sidebar/missions.logic";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  SCRATCH_REPLY_TIMEOUT_MS,
  setScratchPending,
  useScratchPending,
} from "./pendingScratchStore";
import { BackgroundThreadContext } from "./backgroundThread";
import { draftSendState } from "./chatViewSend";
import { useStableCallback } from "~/hooks/useStableCallback";

const ADD_PROJECT_VALUE = "add-project";
const NO_PROJECT_VALUE = "no-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const gt = useGT();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const missionMachines = useDraftProjectMachines(draftId);
  const mission = useDraftMissionChoice(draftId, activeProjectRef?.environmentId ?? null);
  const refocusProject = useRef(false);
  const refocusProjectPicker = () => {
    refocusProject.current = true;
    requestAnimationFrame(() => {
      refocusProject.current = false;
    });
  };

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
    environmentIds: missionMachines,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchHome = missionScratchHome(
    missionMachines,
    scratchEnvironmentId(activeProjectRef?.environmentId ?? null),
    scratchWorkspaceRootFor,
  );
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));
  const canStartScratch = scratchHome !== null && scratchWorkspaceRootFor(scratchHome) !== null;

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems: readonly PickerItem[] = useOrderWhileOpen(
    [
      ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
      ...(canStartScratch ? [{ value: NO_PROJECT_VALUE, label: gt("No project") }] : []),
      { value: ADD_PROJECT_VALUE, label: gt("Add project") },
    ],
    (item) => item.value,
    pickerOpen,
  );
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedValue = isScratchDraft ? NO_PROJECT_VALUE : activeProjectKey;
  const selectedPickerItem = pickerItems.find((item) => item.value === selectedValue) ?? null;

  const pendingScratchRef = useRef<AbortController | null>(null);
  const preparingScratch = useScratchPending(draftId);
  const inBackground = use(BackgroundThreadContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts this draft's pending no-project request when the draft leaves the foreground or the picker unmounts
  useEffect(() => {
    const cancel = () => {
      const pending = pendingScratchRef.current;
      if (pending === null || draftId === null) return;
      pendingScratchRef.current = null;
      setScratchPending(draftId, false);
      pending.abort();
    };
    if (inBackground) cancel();
    return cancel;
  }, [draftId, inBackground]);
  const readProjectMachines = useStableCallback(() => missionMachines);
  const sendInFlight = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return (
      session !== null &&
      draftSendState(scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)))
        .sendInFlight.current
    );
  };
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session && !session.promotedTo
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const mark = missionDraftOf(draftId);
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(projectRef).then((opened) => {
        if (opened !== null && mark !== undefined && missionDraftOf(draftId) === mark) {
          moveMissionDraft(
            draftId,
            opened.draftId,
            scopeThreadRef(projectRef.environmentId, opened.threadId),
          );
        }
      });
      return;
    }
    setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId);
    seedDraftModelSelection(draftId, projectRef);
    const threadId = useComposerDraftStore.getState().getDraftSession(draftId)?.threadId;
    if (mark !== undefined && threadId !== undefined) {
      moveMissionDraft(draftId, draftId, scopeThreadRef(projectRef.environmentId, threadId));
    }
  };
  const startScratch = async () => {
    const requestedTarget = draftTargetKey();
    const home = scratchHome;
    if (!draftId || home === null || isScratchDraft || requestedTarget === null) return;
    if (inBackground || pendingScratchRef.current !== null || sendInFlight()) return;
    const request = new AbortController();
    pendingScratchRef.current = request;
    setScratchPending(draftId, true);
    const requestedMark = missionDraftOf(draftId);
    const timeout = window.setTimeout(() => request.abort(), SCRATCH_REPLY_TIMEOUT_MS);
    const aborted = new Promise<null>((resolve) => {
      request.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const project = await Promise.race([
      openScratchProject(home, undefined, request.signal).catch(() => null),
      aborted,
    ]);
    window.clearTimeout(timeout);
    if (pendingScratchRef.current !== request) return;
    pendingScratchRef.current = null;
    setScratchPending(draftId, false);
    if (request.signal.aborted) {
      toastManager.add({
        type: "error",
        title: gt("Could not start without a project"),
        description: gt("The machine did not answer in time."),
      });
      return;
    }
    if (
      !project ||
      sendInFlight() ||
      draftTargetKey() !== requestedTarget ||
      missionDraftOf(draftId) !== requestedMark
    ) {
      return;
    }
    const machines = readProjectMachines();
    if (machines !== null && !machines.has(home)) {
      toastManager.add({
        type: "warning",
        title: gt("Could not start without a project"),
        description: gt("This draft's mission no longer allows that machine."),
      });
      return;
    }
    refocusProjectPicker();
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
  };

  const projectValue = preparingScratch
    ? gt("No project…")
    : isScratchDraft
      ? gt("No project")
      : (activeProjectTitle ?? gt("Choose a project"));
  const projectSelector = (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        if (item.value === NO_PROJECT_VALUE) {
          void startScratch();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        if (isScratchDraft) refocusProjectPicker();
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              ref={(node: HTMLButtonElement | null) => {
                if (node === null || !refocusProject.current) return;
                refocusProject.current = false;
                node.focus();
              }}
              render={<InlineButton tone="picker" touchTarget="padded" />}
              aria-label={gt("Project: {project}", { project: projectValue })}
              data-draft-project-trigger=""
              disabled={preparingScratch}
              className="pointer-events-auto min-w-0 max-w-full align-baseline"
            />
          }
        >
          {preparingScratch ? <Spinner size="md" tone="muted" /> : null}
          <DraftProjectName value={projectValue} singleLine />
        </TooltipTrigger>
        {activeProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup
        align="center"
        className="w-72 overflow-hidden"
        render={<TooltipScrollDismissArea holdPositionOnExit />}
      >
        <ComboboxSearchInput
          aria-label={gt("Search projects")}
          placeholder={gt("Search projects...")}
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>
          <T>No matching projects.</T>
        </ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : item.value === NO_PROJECT_VALUE ? (
                  <MessageSquareDashedIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  const missionInSentence =
    mission !== null && mission.kind !== "none" && (isScratchDraft || activeProjectTitle !== null);
  const sentenceMission = missionInSentence ? mission.kind : "none";
  const slots = { project: PROJECT_SLOT, mission: MISSION_SLOT };
  const sentence = isScratchDraft
    ? sentenceMission === "member"
      ? gt("What should we work on in mission {mission}?", slots)
      : sentenceMission === "new"
        ? gt("What should we work on in {mission}?", slots)
        : sentenceMission === "lead"
          ? gt("What should we work on as the new lead for {mission}?", slots)
          : gt("What should we work on?")
    : activeProjectTitle === null
      ? gt("{project} to start", slots)
      : sentenceMission === "member"
        ? gt("What should we build in {project}, in mission {mission}?", slots)
        : sentenceMission === "new"
          ? gt("What should we build in {project}, in {mission}?", slots)
          : sentenceMission === "lead"
            ? gt("What should we build in {project}, as the new lead for {mission}?", slots)
            : gt("What should we build in {project}?", slots);
  const { beforeProject, beforeMission, afterMission } = splitDraftHeroSentence(sentence);
  const headingName = [
    beforeProject,
    isScratchDraft ? "" : projectValue,
    beforeMission,
    missionInSentence ? mission.sentenceText : "",
    afterMission,
  ].join("");
  const prose = (text: string) =>
    text ? <span className="[@media(max-height:28rem)]:sr-only">{text}</span> : null;
  const glue = (text: string): [string, string] => {
    const at = text.search(/\s/);
    return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at)];
  };
  const [afterProjectGlue, afterProjectRest] = isScratchDraft
    ? ["", beforeMission]
    : glue(beforeMission);
  const [afterMissionGlue, afterMissionRest] = missionInSentence
    ? glue(afterMission)
    : ["", afterMission];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center [@media(max-height:28rem)]:flex-row [@media(max-height:28rem)]:justify-center [@media(max-height:28rem)]:gap-3">
      <h1
        aria-label={headingName}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl [@media(max-height:28rem)]:contents [@media(max-height:28rem)]:text-sm"
      >
        {prose(beforeProject)}
        {isScratchDraft ? null : (
          <span className="min-w-0 whitespace-nowrap [@media(max-height:28rem)]:max-w-1/2">
            {projectSelector}
            {prose(afterProjectGlue)}
          </span>
        )}
        {prose(afterProjectRest)}
        {mission === null ? null : (
          <span
            className={
              missionInSentence
                ? "min-w-0 whitespace-nowrap [@media(max-height:28rem)]:max-w-1/2"
                : "mt-2 flex min-w-0 justify-center text-sm tracking-normal [@media(max-height:28rem)]:mt-0 [@media(max-height:28rem)]:max-w-1/2"
            }
          >
            {missionInSentence ? mission.inSentence : mission.standalone}
            {prose(afterMissionGlue)}
          </span>
        )}
        {prose(afterMissionRest)}
      </h1>
      {isScratchDraft ? (
        <p className="mt-2 flex min-h-6 w-full min-w-0 items-center justify-center text-sm [@media(max-height:28rem)]:order-first [@media(max-height:28rem)]:mt-0 [@media(max-height:28rem)]:w-auto [@media(max-height:28rem)]:max-w-1/2">
          {projectSelector}
        </p>
      ) : null}
    </div>
  );
}
