import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type Mission,
  type MissionMember,
  MISSION_PROMPT_MAX_LENGTH,
  type ScopedThreadRef,
  type ThreadId,
  threadHasMessages,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import {
  type ComponentProps,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { m } from "../../i18n/messages";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentIdentities, useConnectedEnvironmentIds } from "../../state/environments";
import { openCommandPalette } from "../../commandPaletteBus";
import { contextMenuSourceOf } from "../../contextMenuSource";
import {
  readThreadShell,
  useProject,
  useQuietThreadShell,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { threadFamilies } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addEachToMission,
  buildMissionMenuItems,
  isMissionMenuId,
  claimHere,
  missionLeaveId,
  missionAddSummary,
  type MissionCandidate,
  type MissionDrop,
  missionLeadCandidates,
  type MissionHost,
  resolveMissionDrop,
  type MissionMenuId,
  missionRowItems,
  newMissionId,
  parseMissionTarget,
  type SidebarMission,
  type SidebarMissionEntry,
} from "./missions.logic";
import {
  clearServerThreadMissionDraft,
  markMissionDraft,
  missionDraftOf,
  serverThreadMissionDraftId,
} from "./missionDraftStore";
import { SidebarHeading } from "./SidebarListMarkers";
import type { SidebarMissionToggle } from "./SidebarThreadRow";

export function useMissionHosts(): ReadonlyArray<MissionHost> {
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const connected = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const readable = useEnvironmentsWithScope(
    connected.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  // A fork server from before the capability serves Missions too, with prompts in the list.
  const asked = enabled
    ? connected.flatMap((environmentId) => {
        const config = configs.get(environmentId);
        return readable.has(environmentId) && config !== undefined
          ? [[environmentId, config.environment.capabilities.missions === true] as const]
          : [];
      })
    : [];
  return useAtomValue(serverEnvironment.missionsLiveAcross(JSON.stringify(asked)));
}

const missionCreatePermissionsAtom = environmentAtomList(
  "mission-create-permissions",
  serverEnvironment.createMission.permissionAtom,
);

export function useMissionStartMachines(
  hosts: ReadonlyArray<MissionHost>,
): ReadonlySet<EnvironmentId> {
  const permissions = useAtomValue(
    missionCreatePermissionsAtom(environmentIdsKey(hosts.map((host) => host.environmentId))),
  );
  return new Set(
    hosts.flatMap((host, index) => (permissions[index] === true ? [host.environmentId] : [])),
  );
}

function useMachineLabel(hosts: ReadonlyArray<MissionHost>) {
  const identities = useEnvironmentIdentities();
  return (environmentId: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ??
    hosts
      .flatMap((host) => host.snapshot.links)
      .find((link) => link.environmentId === environmentId)?.label ??
    environmentId;
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred."));
}

function leadChanged(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result) as { readonly reason?: unknown } | null;
  return error?.reason === "lead-changed";
}

export function reportLeadOutcome(
  result: AtomCommandResult<unknown, unknown>,
  retry?: () => void,
): "done" | "lead-changed" | "failed" {
  if (result._tag === "Success") return "done";
  if (leadChanged(result)) {
    toastManager.add(
      stackedThreadToast({ type: "warning", title: m(msg("This mission already has a new lead")) }),
    );
    return "lead-changed";
  }
  reportFailure(m(msg("Could not make this thread the lead")), result, retry);
  return "failed";
}

export function reportFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
  retry?: () => void,
) {
  const message = failureMessage(result);
  if (message === null || isAtomCommandInterrupted(result)) return;
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: message,
      ...(retry === undefined
        ? {}
        : {
            actionProps: {
              children: m(msg("Try again")),
              onClick: () => {
                toastManager.close(toastId);
                retry();
              },
            },
          }),
    }),
  );
}

export function useMissionMenu() {
  const gt = useGT();
  const resolve = useMessages();
  const registry = useContext(RegistryContext);
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const create = useAtomCommand(serverEnvironment.createMission, "mission create");
  const add = useAtomCommand(serverEnvironment.addMissionMember, "mission add member");
  const leave = useAtomCommand(serverEnvironment.leaveMission, "mission leave");
  const release = useAtomCommand(serverEnvironment.releaseMissionMember, "mission release member");
  const deleteMission = useAtomCommand(serverEnvironment.deleteMission, "mission delete");
  const navigate = useNavigate();
  const canChangeOn = (environmentId: EnvironmentId) =>
    registry.get(serverEnvironment.addMissionMember.permissionAtom(environmentId));
  return {
    items: (threads: ReadonlyArray<MissionCandidate>) =>
      enabled ? buildMissionMenuItems(threads, hosts, machineLabel, canChangeOn, resolve) : [],
    rowItems: (host: EnvironmentId, mission: Mission, leadGone: boolean) =>
      missionRowItems({ host, mission, leadGone, canChange: canChangeOn(host) }, resolve),
    leaveId: (ref: ScopedThreadRef, heldBy: Parameters<typeof missionLeaveId>[1]) =>
      missionLeaveId(
        { environmentId: ref.environmentId, id: ref.threadId },
        heldBy,
        hosts,
        canChangeOn,
        heldBy?.mission.missionId,
      ),
    run: async (
      id: MissionMenuId,
      threads: ReadonlyArray<ScopedThreadRef>,
      refusedFirst: ReadonlyArray<string> = [],
      options: { readonly confirm?: boolean } = {},
    ): Promise<ReadonlyArray<ScopedThreadRef>> => {
      const lead = threads[0];
      if (id === "mission-start" && lead !== undefined) {
        const shell = readThreadShell(lead);
        const marked = missionDraftOf(serverThreadMissionDraftId(lead)) !== undefined;
        if (marked || (shell !== null && !threadHasMessages(shell))) {
          if (!marked) {
            markMissionDraft(serverThreadMissionDraftId(lead), {
              intent: { kind: "new" },
              thread: lead,
            });
          }
          void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(lead) });
          return [];
        }
        const result = await create({
          environmentId: lead.environmentId,
          input: { missionId: newMissionId(), leadThreadId: lead.threadId },
        });
        reportFailure(gt("Could not start the mission"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      const target = parseMissionTarget(id);
      if (target === null) return [];
      if (target.action === "leave") {
        if (lead === undefined) return [];
        const claim = claimHere({ ...lead, id: lead.threadId }, hosts);
        if (options.confirm !== false && claim?.missionId === target.missionId) {
          const confirmed = await readLocalApi()?.dialogs.confirm(
            gt('Leave the mission "{mission}"? Its lead will see that this thread left.', {
              mission: claim.name,
            }),
          );
          if (confirmed !== true) return [];
        }
        const result = await leave({
          environmentId: target.environmentId,
          input: { threadId: lead.threadId, missionId: target.missionId },
        });
        reportFailure(gt("Could not leave the mission"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      const snapshot = hosts.find((host) => host.environmentId === target.environmentId)?.snapshot;
      const mission = snapshot?.missions.find(
        (candidate) => candidate.missionId === target.missionId,
      );
      if (target.action === "new-thread" && mission !== undefined) {
        openCommandPalette({
          open: "new-thread-in",
          mission: {
            kind: "member",
            host: target.environmentId,
            missionId: target.missionId,
            name: mission.name,
          },
        });
        return [];
      }
      if (target.action === "delete" && mission !== undefined) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          gt('Delete the mission "{mission}"? Its lead stays as a thread of its own.', {
            mission: mission.name,
          }),
          { variant: "destructive" },
        );
        if (confirmed !== true) return [];
        reportFailure(
          gt("Could not delete the mission"),
          await deleteMission({
            environmentId: target.environmentId,
            input: { missionId: target.missionId },
          }),
        );
        return [];
      }
      if (target.action === "prompt" && mission !== undefined) {
        registry.set(missionPromptTargetAtom, {
          host: target.environmentId,
          mission,
          promptsOmitted: snapshot?.promptsOmitted === true,
        });
        return [];
      }
      if (target.action === "release") {
        if (lead === undefined) return [];
        const result = await release({
          environmentId: target.environmentId,
          input: { missionId: target.missionId, member: lead },
        });
        reportFailure(gt("Could not leave the mission"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      if (target.action !== "add") return [];
      const outcome = await addEachToMission(threads, async (member) =>
        failureMessage(
          await add({
            environmentId: target.environmentId,
            input: { missionId: target.missionId, member },
          }),
        ),
      );
      for (const added of outcome.added) clearServerThreadMissionDraft(added);
      const summary = missionAddSummary(
        { ...outcome, refused: [...refusedFirst, ...outcome.refused] },
        resolve,
      );
      if (summary !== null) toastManager.add(stackedThreadToast({ type: "error", title: summary }));
      return outcome.added;
    },
  };
}

const missionPromptTargetAtom = Atom.make<{
  readonly host: EnvironmentId;
  readonly mission: Mission;
  readonly promptsOmitted: boolean;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mission-prompt-target"));

export function MissionPromptDialog() {
  const registry = useContext(RegistryContext);
  const target = useAtomValue(missionPromptTargetAtom);
  const close = () => registry.set(missionPromptTargetAtom, null);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-xl">
        {target === null ? null : (
          <MissionPromptForm
            host={target.host}
            mission={target.mission}
            promptsOmitted={target.promptsOmitted}
            onClose={close}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function MissionPromptForm(props: {
  readonly host: EnvironmentId;
  readonly mission: Mission;
  readonly promptsOmitted: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const read = useEnvironmentQuery(
    props.promptsOmitted
      ? serverEnvironment.missionPrompt({
          environmentId: props.host,
          input: { missionId: props.mission.missionId },
        })
      : null,
    resolve,
  );
  const listed =
    useMissionHosts()
      .find((host) => host.environmentId === props.host)
      ?.snapshot.missions.find((mission) => mission.missionId === props.mission.missionId) ??
    props.mission;
  const loaded = props.promptsOmitted ? (read.data?.prompt ?? null) : (listed.prompt ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  // The server trims the prompt it saves.
  const next = draft?.trim();
  const changed = loaded !== null && next !== undefined && next !== loaded;
  const setPrompt = useAtomCommand(serverEnvironment.setMissionPrompt, "mission set prompt");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!changed) return;
        const result = await setPrompt({
          environmentId: props.host,
          input: { missionId: props.mission.missionId, prompt: next },
        });
        reportFailure(gt("Could not save the mission prompt"), result);
        if (result._tag === "Success") props.onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{gt("Mission prompt")}</DialogTitle>
        <DialogDescription>
          {(props.promptsOmitted ? read.error : null) ??
            gt(
              'The lead of "{mission}" follows this on every turn. Leave it empty to use the default from Settings.',
              { mission: listed.name },
            )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Textarea
          name="prompt"
          aria-label={gt("Mission prompt")}
          rows={8}
          maxLength={MISSION_PROMPT_MAX_LENGTH}
          disabled={loaded === null}
          value={draft ?? loaded ?? ""}
          onChange={(event) => setDraft(event.target.value)}
        />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          {gt("Cancel")}
        </Button>
        <Button type="submit" disabled={!changed}>
          {gt("Save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function MemberRow(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly member: MissionMember;
  readonly machineLabel: string;
  readonly missionName: string;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly toggle?: SidebarMissionToggle | undefined;
  readonly stateOnly?: boolean;
  readonly inRow?: boolean;
  readonly onContextMenu?: (event: ReactMouseEvent) => void;
  readonly missingLead?: MissingLead;
}) {
  const gt = useGT();
  const dismisses = props.member.state === "add-refused";
  const thread = useQuietThreadShell(dismisses ? null : props.member.ref);
  const project = useProject(
    thread === null ? null : { environmentId: thread.environmentId, projectId: thread.projectId },
  );
  const canRelease = useAtomValue(
    serverEnvironment.releaseMissionMember.permissionAtom(props.host),
  );
  const release = useAtomCommand(serverEnvironment.releaseMissionMember, "mission release member");
  const forget = useAtomCommand(serverEnvironment.forgetMissionMember, "mission forget member");
  const menu = useMissionMenu();
  const leaveId = menu.leaveId(props.member.ref, {
    host: props.host,
    mission: { missionId: props.missionId },
  });
  const [releasing, setReleasing] = useState(false);
  const deleted = props.member.state === "deleted";
  const title = deleted
    ? gt("Lead deleted", { $context: "the thread that led a mission no longer exists" })
    : (thread?.title ??
      (props.member.role === "lead"
        ? props.missionName
        : gt("Thread on {machine}", { machine: props.machineLabel })));
  const where =
    project === null || props.toggle !== undefined
      ? props.machineLabel
      : `${props.machineLabel} · ${project.title}`;
  const active = props.member.state === "active";
  const forgets = props.member.state === "add-pending" || props.member.state === "release-pending";
  const releaseRefused = props.member.state === "release-refused";
  const command = {
    environmentId: props.host,
    input: { missionId: props.missionId, member: props.member.ref },
  };
  const leaveNow = (id: MissionMenuId) => menu.run(id, [props.member.ref], [], { confirm: false });
  const onRelease = async () => {
    if (forgets) {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        gt(
          "Forget this thread? Nothing is sent to its machine. If that machine comes back still holding the thread, someone there can free it with Leave mission.",
        ),
      );
      if (confirmed !== true) return;
    }
    setReleasing(true);
    if (forgets || releaseRefused) {
      reportFailure(gt("Could not forget the thread"), await forget(command));
    } else if (dismisses) {
      reportFailure(gt("Could not leave the mission"), await release(command));
    } else if (leaveId !== null) await leaveNow(leaveId);
    setReleasing(false);
  };
  const onRetry = async () => {
    if (leaveId === null) return;
    setReleasing(true);
    await leaveNow(leaveId);
    setReleasing(false);
  };
  const { toggle } = props;
  const stateText =
    props.member.state === "release-pending"
      ? gt("Leave pending (machine offline)")
      : props.member.state === "add-pending"
        ? gt("Add pending (machine offline)")
        : props.member.state === "add-refused"
          ? props.member.detail
          : releaseRefused
            ? gt("Leave refused: {reason}", { reason: props.member.detail ?? "" })
            : props.member.state === "offline"
              ? gt("Last known (machine offline)")
              : where;
  const dismissLabel = forgets
    ? gt("Forget")
    : dismisses || releaseRefused
      ? gt("Dismiss")
      : gt("Leave mission");
  const action =
    props.member.role === "member" ? (
      <span className="flex shrink-0 opacity-0 transition-opacity group-hover/mission-row:opacity-100 has-focus-visible:opacity-100">
        {releaseRefused ? (
          <MemberRowAction
            label={gt("Retry")}
            disabled={leaveId === null || releasing}
            onClick={() => void onRetry()}
          >
            <RotateCcwIcon />
          </MemberRowAction>
        ) : null}
        <MemberRowAction
          label={dismissLabel}
          disabled={
            releasing || (forgets || dismisses || releaseRefused ? !canRelease : leaveId === null)
          }
          onClick={() => void onRelease()}
        >
          <XIcon />
        </MemberRowAction>
      </span>
    ) : null;
  if (props.inRow === true) {
    return (
      <div className="group/mission-row mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
        <span className="min-w-0 flex-1 truncate">{stateText}</span>
        {action}
      </div>
    );
  }
  return (
    <li className="group/mission-row list-none" onContextMenu={props.onContextMenu}>
      <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-sidebar-row-hover">
        {toggle ? (
          <button
            type="button"
            aria-expanded={toggle.expanded}
            aria-label={
              toggle.expanded
                ? gt(
                    "Collapse mission {mission}, {count, plural, one {{count} thread} other {{count} threads}}",
                    { mission: title, count: toggle.memberCount },
                  )
                : gt(
                    "Expand mission {mission}, {count, plural, one {{count} thread} other {{count} threads}}",
                    { mission: title, count: toggle.memberCount },
                  )
            }
            onClick={toggle.onToggle}
            className="mt-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center self-start rounded-sm text-sidebar-muted-foreground hover:text-sidebar-foreground"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 transition-transform", !toggle.expanded && "-rotate-90")}
            />
          </button>
        ) : null}
        <button
          type="button"
          disabled={thread === null}
          onClick={() => props.onOpen(props.member.ref)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col text-left disabled:cursor-default"
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-sm",
              active ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
            )}
          >
            {props.stateOnly || dismisses ? null : <span className="truncate">{title}</span>}
            {toggle && !toggle.expanded && toggle.memberCount > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                {toggle.memberCount}
              </span>
            ) : null}
          </span>
          <span className="truncate text-2xs text-sidebar-muted-foreground">{stateText}</span>
        </button>
        {action}
      </div>
      {props.missingLead ? <MissingLeadActions actions={props.missingLead} /> : null}
    </li>
  );
}

function MemberRowAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function useMissingLead(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly missionName: string;
  readonly expectedLead: ThreadId;
  readonly hosts: ReadonlyArray<MissionHost>;
}) {
  const gt = useGT();
  const shells = useQuietThreadShells();
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  const allowed = useAtomValue(serverEnvironment.setMissionLead.permissionAtom(props.host));
  const newLead = () =>
    openCommandPalette({
      open: "new-thread-in",
      mission: {
        kind: "lead",
        host: props.host,
        missionId: props.missionId,
        name: props.missionName,
        expectedLead: props.expectedLead,
      },
    });
  const chooseLead = async (event: ReactMouseEvent) => {
    const candidates = missionLeadCandidates(
      shells,
      { host: props.host, missionId: props.missionId },
      props.hosts,
    ).slice(0, LEAD_CHOICES);
    const picked = await readLocalApi()?.contextMenu.show<string>(
      candidates.length === 0
        ? [{ id: "none", label: gt("No thread here can lead it"), disabled: true }]
        : candidates.map((candidate) => ({ id: candidate.id, label: candidate.title })),
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    const lead = candidates.find((candidate) => candidate.id === picked);
    if (lead === undefined) return;
    reportLeadOutcome(
      await setLead({
        environmentId: props.host,
        input: {
          missionId: props.missionId,
          lead: { environmentId: lead.environmentId, threadId: lead.id },
          expectedLead: props.expectedLead,
        },
      }),
    );
  };
  return { allowed, newLead, chooseLead };
}
type MissingLead = ReturnType<typeof useMissingLead>;

function MissingLeadActions(props: { readonly actions: MissingLead }) {
  return (
    <div className="flex gap-3 ps-7.5 pb-1 text-2xs">
      <InlineButton onClick={props.actions.newLead}>
        <T>New lead</T>
      </InlineButton>
      <InlineButton onClick={(event) => void props.actions.chooseLead(event)}>
        <T>Choose a thread…</T>
      </InlineButton>
    </div>
  );
}

function MissionLeadRow(
  props: Omit<ComponentProps<typeof MemberRow>, "onContextMenu" | "missingLead"> & {
    readonly mission: Mission;
    readonly hosts: ReadonlyArray<MissionHost>;
  },
) {
  const { mission, hosts, ...row } = props;
  const menu = useMissionMenu();
  const missingLead = useMissingLead({
    host: props.host,
    missionId: mission.missionId,
    missionName: mission.name,
    expectedLead: props.member.ref.threadId,
    hosts,
  });
  const deleted = props.member.state === "deleted" && missingLead.allowed;
  const onContextMenu = async (event: ReactMouseEvent) => {
    event.preventDefault();
    const picked = await readLocalApi()?.contextMenu.show(
      menu.rowItems(props.host, mission, missingLead.allowed),
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    if (picked === "mission-new-lead") missingLead.newLead();
    else if (picked === "mission-choose-lead") await missingLead.chooseLead(event);
    else if (picked != null && isMissionMenuId(picked)) await menu.run(picked, []);
  };
  return (
    <MemberRow
      {...row}
      onContextMenu={(event) => void onContextMenu(event)}
      {...(deleted ? { missingLead } : {})}
    />
  );
}

const LOAD_WAIT_MS = 10_000;

async function loadThreadShell(ref: ScopedThreadRef): Promise<EnvironmentThreadShell | null> {
  const known = readThreadShell(ref);
  if (known !== null) return known;
  const release = threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId);
  try {
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: threadFamilies.familyAtom(ref.environmentId, ref.threadId),
      predicate: (read) => threadFamilyRead(read) !== "pending",
      timeoutMs: LOAD_WAIT_MS,
    });
    return readThreadShell(ref);
  } finally {
    release();
  }
}

const LEAD_CHOICES = 20;

export function SidebarMissions(props: {
  readonly missions: ReadonlyArray<SidebarMission<EnvironmentThreadShell>>;
  readonly headerVisible: boolean;
  readonly renderThreadRow: (
    thread: EnvironmentThreadShell,
    toggle?: SidebarMissionToggle,
    footer?: (inRow: boolean) => ReactNode,
  ) => ReactNode;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  readonly dropTarget?: MissionDrop | null;
}) {
  const gt = useGT();
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const missionExpandedById = useUiStateStore((state) => state.missionExpandedById);
  const setMissionExpanded = useUiStateStore((state) => state.setMissionExpanded);
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  if (!enabled || props.missions.length === 0) return null;
  const row = (
    mission: SidebarMission<EnvironmentThreadShell>,
    entry: SidebarMission<EnvironmentThreadShell>["lead"],
    toggle?: SidebarMissionToggle,
  ) =>
    entry.thread === null && entry.member.role === "lead" ? (
      <MissionLeadRow
        key={scopedKey(entry.member.ref)}
        host={mission.host}
        missionId={mission.mission.missionId}
        member={entry.member}
        machineLabel={machineLabel(entry.member.ref.environmentId)}
        missionName={mission.mission.name}
        onOpen={props.onOpenThread}
        toggle={toggle}
        mission={mission.mission}
        hosts={hosts}
      />
    ) : entry.thread === null ? (
      <MemberRow
        key={scopedKey(entry.member.ref)}
        host={mission.host}
        missionId={mission.mission.missionId}
        member={entry.member}
        machineLabel={machineLabel(entry.member.ref.environmentId)}
        missionName={mission.mission.name}
        onOpen={props.onOpenThread}
        toggle={toggle}
      />
    ) : (
      <Fragment key={scopedKey(entry.member.ref)}>
        {props.renderThreadRow(
          entry.thread,
          toggle,
          entry.member.state === "add-pending" ||
            entry.member.state === "release-pending" ||
            entry.member.state === "release-refused"
            ? (inRow) => (
                <MemberRow
                  host={mission.host}
                  missionId={mission.mission.missionId}
                  member={entry.member}
                  machineLabel={machineLabel(entry.member.ref.environmentId)}
                  missionName={mission.mission.name}
                  onOpen={props.onOpenThread}
                  stateOnly
                  inRow={inRow}
                />
              )
            : undefined,
        )}
      </Fragment>
    );
  return (
    <>
      {props.headerVisible ? (
        <SidebarHeading>{gt("Missions", { $context: "sidebar section" })}</SidebarHeading>
      ) : null}
      {props.missions.map((mission) => {
        const expanded = missionExpandedById[mission.key] ?? true;
        const drop =
          props.dropTarget?.kind === "add" && props.dropTarget.mission === mission.key
            ? props.dropTarget
            : null;
        return (
          <li key={mission.key} className="list-none" data-mission-drop={mission.key}>
            <ul
              className={cn(
                "flex flex-col gap-px rounded-md",
                drop !== null && "bg-accent/45 ring-1 ring-inset ring-primary/70",
              )}
            >
              {row(mission, mission.lead, {
                expanded,
                memberCount: mission.members.length,
                onToggle: () => setMissionExpanded(mission.key, !expanded),
              })}
              {drop === null ? null : (
                <li
                  role="status"
                  className={cn(
                    "list-none px-2 pb-1 text-xs",
                    drop.refusal === null ? "text-primary" : "text-sidebar-muted-foreground",
                  )}
                >
                  {drop.refusal ?? gt("Add to mission")}
                </li>
              )}
              {expanded && mission.members.length > 0 ? (
                <li className="list-none" data-testid="sidebar-mission-members">
                  <ul className="ms-3 flex flex-col gap-px border-s border-sidebar-border ps-1">
                    {mission.members.map((entry) => row(mission, entry))}
                  </ul>
                </li>
              ) : null}
            </ul>
          </li>
        );
      })}
    </>
  );
}

const scopedKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

export function useMissionLeadShells(
  leads: ReadonlyArray<SidebarMissionEntry<EnvironmentThreadShell>>,
) {
  const [mounted, setMounted] = useState<ReadonlyArray<string>>([]);
  const wanted = leads.flatMap((lead) => {
    const key = scopedThreadKey(lead.member.ref);
    return lead.member.state === "active" && (lead.thread === null || mounted.includes(key))
      ? [key]
      : [];
  });
  const wantedKey = JSON.stringify(wanted);
  if (wantedKey !== JSON.stringify(mounted)) setMounted(wanted);
  const held = useRef(new Map<string, () => void>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds each listed lead's family in the thread family registry, leaving the ones already held in place
  useEffect(() => {
    const keys = new Set(JSON.parse(wantedKey) as ReadonlyArray<string>);
    for (const [key, release] of held.current) {
      if (keys.has(key)) continue;
      release();
      held.current.delete(key);
    }
    for (const key of keys) {
      const ref = parseScopedThreadKey(key);
      if (ref === null || held.current.has(key)) continue;
      held.current.set(key, threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId));
    }
  }, [wantedKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases every held lead family when the sidebar unmounts
  useEffect(
    () => () => {
      for (const release of held.current.values()) release();
      held.current.clear();
    },
    [],
  );
}

const settledLeadReadsAtom = Atom.family((keys: string) =>
  Atom.make(
    (get): ReadonlySet<string> =>
      new Set(
        (JSON.parse(keys) as ReadonlyArray<string>).filter((key) => {
          const ref = parseScopedThreadKey(key);
          return (
            ref !== null &&
            threadFamilyRead(get(threadFamilies.familyAtom(ref.environmentId, ref.threadId))) ===
              "settled"
          );
        }),
      ),
  ),
);

export function useUnavailableMissionLeads(
  hosts: ReadonlyArray<MissionHost>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlySet<string> {
  const listed = new Set(
    threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const missing = hosts.flatMap((host) =>
    host.snapshot.missions.flatMap((mission) =>
      mission.members.flatMap((member) => {
        const key = scopedThreadKey(member.ref);
        return member.role === "lead" && member.state === "active" && !listed.has(key) ? [key] : [];
      }),
    ),
  );
  return useAtomValue(settledLeadReadsAtom(JSON.stringify(missing)));
}

export function useMissionDrop(missions: ReadonlyArray<SidebarMission<EnvironmentThreadShell>>) {
  const resolve = useMessages();
  const registry = useContext(RegistryContext);
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const menu = useMissionMenu();
  const [target, setTarget] = useState<MissionDrop | null>(null);
  const source = useRef<{
    readonly dragged: string;
    readonly from: { readonly host: EnvironmentId; readonly missionId: string } | null;
  } | null>(null);
  type At = {
    readonly point: { readonly x: number; readonly y: number };
    readonly list: HTMLElement | null;
    readonly dragged: string | null;
    readonly refs: ReadonlyArray<ScopedThreadRef>;
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  };
  const add = async (id: MissionMenuId, refs: ReadonlyArray<ScopedThreadRef>) => {
    const read = await Promise.all(
      refs.map(async (ref) => [ref, await loadThreadShell(ref)] as const),
    );
    const notLoaded = read
      .filter(([, shell]) => shell === null)
      .map(() => resolve(msg("Not loaded.")));
    await menu.run(
      id,
      read.flatMap(([ref, shell]) => (shell === null ? [] : [ref])),
      notLoaded,
    );
  };
  const dropAt = ({ point, list, dragged, threads }: At) => {
    if (list === null || dragged === null || missions.length === 0) return null;
    const contains = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return (
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
      );
    };
    const viewport = list.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (viewport !== null && !contains(viewport)) return null;
    const mission = [...list.querySelectorAll<HTMLElement>("[data-mission-drop]")].find(contains);
    const zone = list.querySelector<HTMLElement>('[data-mission-release="zone"]');
    const below = zone?.getBoundingClientRect().top ?? Infinity;
    const releases =
      zone !== null &&
      ([...list.querySelectorAll<HTMLElement>("[data-mission-release]")].some(contains) ||
        [...list.querySelectorAll<HTMLElement>("[data-thread-item]")].some(
          (row) => row.getBoundingClientRect().top >= below && contains(row),
        ));
    if (source.current?.dragged !== dragged) {
      const from = missions.find((mission) =>
        mission.members.some((entry) => scopedThreadKey(entry.member.ref) === dragged),
      );
      source.current = {
        dragged,
        from: from === undefined ? null : { host: from.host, missionId: from.mission.missionId },
      };
    }
    return resolveMissionDrop({
      dragged,
      threads,
      source: source.current.from,
      over: mission?.dataset.missionDrop ?? (releases ? "list" : null),
      missions,
      hosts,
      machineLabel,
      canChangeOn: (environmentId) =>
        registry.get(serverEnvironment.addMissionMember.permissionAtom(environmentId)),
      resolve,
    });
  };
  const show = (next: MissionDrop | null) =>
    setTarget((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  return {
    target,
    move: useStableCallback((at: At) => {
      const next = dropAt(at);
      show(next);
      return next !== null;
    }),
    drop: useStableCallback((at: At) => {
      const next = dropAt(at);
      source.current = null;
      show(null);
      if (next === null) return false;
      if (next.refusal !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title:
              next.kind === "add"
                ? resolve(msg("Not added to the mission"))
                : resolve(msg("Did not leave the mission")),
            description: next.refusal,
          }),
        );
      } else if (next.kind === "add") {
        void add(`mission-add:${next.host}:${next.missionId}`, at.refs);
      } else if (next.refusal === null) {
        const dragged = at.refs.filter((ref) => scopedThreadKey(ref) === at.dragged);
        const leave =
          dragged[0] &&
          menu.leaveId(dragged[0], { host: next.host, mission: { missionId: next.missionId } });
        if (leave) void menu.run(leave, dragged, [], { confirm: false });
      }
      return true;
    }),
    clear: useStableCallback(() => {
      source.current = null;
      show(null);
    }),
    leavable: new Set(
      missions.flatMap((mission) =>
        mission.members.flatMap(({ member }) =>
          member.role === "member" &&
          menu.leaveId(member.ref, { host: mission.host, mission: mission.mission }) !== null
            ? [scopedThreadKey(member.ref)]
            : [],
        ),
      ),
    ),
  };
}
