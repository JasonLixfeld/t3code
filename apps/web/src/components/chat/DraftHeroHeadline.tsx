import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { T, useGT } from "gt-react";
import { FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SelectButton } from "../ui/select";
import { DraftProjectName } from "./DraftProjectName";
import { TriageDraftHero } from "./TriageDraftHero";
import { DraftMissionSelect, useDraftProjectMachines } from "./DraftMissionSelect";
import { missionDraftOf, moveMissionDraft } from "../sidebar/missionDraftStore";
import { missionScratchHome } from "../sidebar/missions.logic";

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
  // A Mission draft offers only the projects on machines where its Mission can take it.
  const missionMachines = useDraftProjectMachines(draftId);

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

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft's target and Mission mark
  // are compared against the stores when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  // Null once the draft is sending, so a request from before the send never applies.
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
    pendingScratchRef.current = null;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const mark = missionDraftOf(draftId);
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(projectRef).then((opened) => {
        // A mark that changed while the project's draft opened stays on its own draft.
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
    if (scratchHome === null || isScratchDraft) return;
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const requestedMark = missionDraftOf(draftId);
    const project = await openScratchProject(scratchHome);
    if (
      !project ||
      pendingScratchRef.current !== request ||
      requestedTarget === null ||
      draftTargetKey() !== requestedTarget ||
      missionDraftOf(draftId) !== requestedMark
    ) {
      return;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
  };

  const projectValue = isScratchDraft
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
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<SelectButton className="w-auto min-w-0 max-w-72" />}
              aria-label={gt("Project: {project}", { project: projectValue })}
              data-draft-project-trigger=""
              className="pointer-events-auto"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              <T>Project</T>
            </span>
            {isScratchDraft ? (
              <MessageSquareDashedIcon className="size-4" />
            ) : activeProjectGroup ? (
              <ProjectFavicon project={activeProjectGroup} className="size-4" />
            ) : null}
            <DraftProjectName value={projectValue} singleLine />
          </span>
        </TooltipTrigger>
        {activeProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden">
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl [@media(max-height:28rem)]:sr-only">
        {gt("What should we build?")}
      </h1>
      <div className="mt-4 flex w-full flex-wrap items-center justify-center gap-2">
        {projectSelector}
        {draftId && activeProjectRef ? (
          <DraftMissionSelect draftId={draftId} environmentId={activeProjectRef.environmentId} />
        ) : null}
      </div>
    </div>
  );
}
