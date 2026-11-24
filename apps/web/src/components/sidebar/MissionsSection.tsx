import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, MissionMember, ScopedThreadRef } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import {
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
import { useProject, useQuietThreadShell, useQuietThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadFamilies } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addEachToMission,
  buildMissionMenuItems,
  claimHere,
  missionAddSummary,
  type MissionCandidate,
  type MissionDrop,
  missionLeadCandidates,
  type MissionHost,
  resolveMissionDrop,
  type MissionMenuId,
  parseMissionTarget,
  type SidebarMission,
  type SidebarMissionEntry,
} from "./missions.logic";
import { SidebarHeading } from "./SidebarListMarkers";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import type { SidebarMissionToggle } from "./SidebarThreadRow";

/** No machine is asked for its Missions while the sidebar setting turns them off. */
export function useMissionHosts(): ReadonlyArray<MissionHost> {
  const enabled = useClientSettings((settings) => settings.sidebarMissionsEnabled);
  const environmentIds = useConnectedEnvironmentIds();
  const hosts = useAtomValue(
    serverEnvironment.missionsLiveAcross(JSON.stringify(enabled ? environmentIds : [])),
  );
  return enabled ? hosts : NO_HOSTS;
}
const NO_HOSTS: ReadonlyArray<MissionHost> = [];

function useMachineLabel(hosts: ReadonlyArray<MissionHost>) {
  const identities = useEnvironmentIdentities();
  return (environmentId: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ??
    hosts
      .flatMap((host) => host.snapshot.links)
      .find((link) => link.environmentId === environmentId)?.label ??
    environmentId;
}

/** Why a command did not run, or null when it ran. */
function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred."));
}

export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const message = failureMessage(result);
  if (message === null || isAtomCommandInterrupted(result)) return;
  toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
}

/** The Mission entries of a thread menu, and what choosing one does. */
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
  // One source for single and bulk adds: the right to change Missions on the machine that keeps them.
  const canChangeOn = (environmentId: EnvironmentId) =>
    registry.get(serverEnvironment.addMissionMember.permissionAtom(environmentId));
  return {
    items: (threads: ReadonlyArray<MissionCandidate>) =>
      enabled ? buildMissionMenuItems(threads, hosts, machineLabel, canChangeOn, resolve) : [],
    /** The threads that got where they were sent; the rest stay selected. */
    run: async (
      id: MissionMenuId,
      threads: ReadonlyArray<ScopedThreadRef>,
    ): Promise<ReadonlyArray<ScopedThreadRef>> => {
      const lead = threads[0];
      if (id === "mission-start" && lead !== undefined) {
        const result = await create({
          environmentId: lead.environmentId,
          input: { missionId: newMissionId(), leadThreadId: lead.threadId },
        });
        reportFailure(gt("Could not start the mission"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      const claim =
        lead === undefined ? undefined : claimHere({ ...lead, id: lead.threadId }, hosts);
      if (id === "mission-leave" && lead !== undefined && claim !== undefined) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          gt('Leave the mission "{mission}"? Its lead will see this thread as released.', {
            mission: claim.name,
          }),
        );
        if (confirmed !== true) return [];
        const result = await leave({
          environmentId: lead.environmentId,
          input: { threadId: lead.threadId },
        });
        reportFailure(gt("Could not leave the mission"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      const target = parseMissionTarget(id);
      if (target === null) return [];
      if (target.action === "release") {
        if (lead === undefined) return [];
        const result = await release({
          environmentId: target.environmentId,
          input: { missionId: target.missionId, member: lead },
        });
        reportFailure(gt("Could not release the thread"), result);
        return result._tag === "Success" ? [lead] : [];
      }
      const outcome = await addEachToMission(threads, async (member) =>
        failureMessage(
          await add({
            environmentId: target.environmentId,
            input: { missionId: target.missionId, member },
          }),
        ),
      );
      const summary = missionAddSummary(outcome, resolve);
      if (summary !== null) toastManager.add(stackedThreadToast({ type: "error", title: summary }));
      return outcome.added;
    },
  };
}

/** Twelve hex digits, as Mission ids in tags are. */
export const newMissionId = () => SecureRandom.uuidV4Unsafe().replaceAll("-", "").slice(0, 12);

function MemberRow(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly member: MissionMember;
  readonly machineLabel: string;
  /** Names a lead whose thread this client has not read yet. */
  readonly missionName: string;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  /** Set on a lead row this client has no thread for, so it still folds its members. */
  readonly toggle?: SidebarMissionToggle | undefined;
  /** Under the thread's own row: only the waiting state and its action. */
  readonly stateOnly?: boolean;
  /** Inside the thread's own row, as its last line. */
  readonly inRow?: boolean;
  readonly hosts?: ReadonlyArray<MissionHost>;
}) {
  const gt = useGT();
  // A refused add never joined, so its row is only the refusal: no title, nothing to open.
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
  const [releasing, setReleasing] = useState(false);
  const deleted = props.member.state === "deleted";
  const title = deleted
    ? gt("Lead deleted", { $context: "the thread that led a mission no longer exists" })
    : (thread?.title ??
      (props.member.role === "lead"
        ? props.missionName
        : gt("Thread on {machine}", { machine: props.machineLabel })));
  // A mission's lead row names no project: a mission can span several.
  const where =
    project === null || props.toggle !== undefined
      ? props.machineLabel
      : `${props.machineLabel} · ${project.title}`;
  const active = props.member.state === "active";
  // Its machine has not answered, and may never: the lead can stop waiting without asking it.
  const forgets = props.member.state === "add-pending" || props.member.state === "release-pending";
  const command = {
    environmentId: props.host,
    input: { missionId: props.missionId, member: props.member.ref },
  };
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
    if (forgets) reportFailure(gt("Could not forget the thread"), await forget(command));
    else reportFailure(gt("Could not release the thread"), await release(command));
    setReleasing(false);
  };
  const { toggle } = props;
  const stateText =
    props.member.state === "release-pending"
      ? gt("Release pending (machine offline)")
      : props.member.state === "add-pending"
        ? gt("Add pending (machine offline)")
        : props.member.state === "add-refused"
          ? props.member.detail
          : props.member.state === "offline"
            ? gt("Last known (machine offline)")
            : where;
  const action =
    props.member.role === "member" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={
                forgets ? gt("Forget") : dismisses ? gt("Dismiss") : gt("Release from mission")
              }
              disabled={!canRelease || releasing}
              onClick={(event) => {
                // Inside a thread's row, the row would open the thread as well.
                event.stopPropagation();
                void onRelease();
              }}
              className="inline-flex shrink-0 cursor-pointer items-center rounded-md px-1 text-muted-foreground opacity-0 transition-opacity group-hover/mission-row:opacity-100 hover:text-foreground focus-visible:opacity-100 disabled:cursor-default"
            >
              <XIcon className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="top">
          {forgets ? gt("Forget") : dismisses ? gt("Dismiss") : <T>Release from mission</T>}
        </TooltipPopup>
      </Tooltip>
    ) : null;
  // The last line of the thread's own row, styled as its other lines.
  if (props.inRow === true) {
    return (
      <div className="group/mission-row mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
        <span className="min-w-0 flex-1 truncate">{stateText}</span>
        {action}
      </div>
    );
  }
  return (
    <li className="group/mission-row list-none">
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
      {deleted && props.member.role === "lead" ? (
        <MissingLeadActions
          host={props.host}
          missionId={props.missionId}
          missionName={props.missionName}
          hosts={props.hosts ?? []}
        />
      ) : null}
    </li>
  );
}

/** A Mission whose lead is gone takes a new lead: a draft sent on its machine, or a thread there. */
function MissingLeadActions(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly missionName: string;
  readonly hosts: ReadonlyArray<MissionHost>;
}) {
  const gt = useGT();
  const shells = useQuietThreadShells();
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  const allowed = useAtomValue(serverEnvironment.setMissionLead.permissionAtom(props.host));
  if (!allowed) return null;
  const newLead = () =>
    openCommandPalette({
      open: "new-thread-in",
      mission: {
        kind: "lead",
        host: props.host,
        missionId: props.missionId,
        name: props.missionName,
      },
    });
  const chooseLead = async (event: ReactMouseEvent) => {
    const candidates = missionLeadCandidates(
      shells,
      { host: props.host, missionId: props.missionId },
      props.hosts,
    ).slice(0, LEAD_CHOICES);
    const picked = await readLocalApi()?.contextMenu.show(
      candidates.length === 0
        ? [{ id: "none", label: gt("No thread here can lead it"), disabled: true }]
        : candidates.map((candidate) => ({ id: candidate.id as string, label: candidate.title })),
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    const lead = candidates.find((candidate) => candidate.id === picked);
    if (lead === undefined) return;
    reportFailure(
      gt("Could not make this thread the lead"),
      await setLead({
        environmentId: props.host,
        input: {
          missionId: props.missionId,
          lead: { environmentId: lead.environmentId, threadId: lead.id },
        },
      }),
    );
  };
  return (
    // Lined up with the title, past the chevron.
    <div className="flex gap-3 ps-7.5 pb-1 text-2xs font-medium text-sidebar-foreground">
      <button type="button" className="cursor-pointer hover:underline" onClick={newLead}>
        <T>New lead</T>
      </button>
      <button
        type="button"
        className="cursor-pointer hover:underline"
        onClick={(event) => void chooseLead(event)}
      >
        <T>Choose a thread…</T>
      </button>
    </div>
  );
}

/** How many threads "Choose a thread…" offers, most recently written first. */
const LEAD_CHOICES = 20;

/**
 * The Missions above the thread list. Each lead's own thread row heads its Mission, and its
 * members' rows sit under it. A row this client has no thread for keeps the Mission's own row.
 */
export function SidebarMissions(props: {
  readonly missions: ReadonlyArray<SidebarMission<EnvironmentThreadShell>>;
  readonly headerVisible: boolean;
  readonly renderThreadRow: (
    thread: EnvironmentThreadShell,
    toggle?: SidebarMissionToggle,
    /** The waiting state of a member's add or release, inside its row or under it. */
    footer?: (inRow: boolean) => ReactNode,
  ) => ReactNode;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  /** Where a drag over the sidebar would drop, while one is under way. */
  readonly dropTarget?: MissionDrop | null;
}) {
  const gt = useGT();
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const missionExpandedById = useUiStateStore((state) => state.missionExpandedById);
  const setMissionExpanded = useUiStateStore((state) => state.setMissionExpanded);
  if (props.missions.length === 0) return null;
  const row = (
    mission: SidebarMission<EnvironmentThreadShell>,
    entry: SidebarMission<EnvironmentThreadShell>["lead"],
    toggle?: SidebarMissionToggle,
  ) =>
    entry.thread === null ? (
      <MemberRow
        key={scopedKey(entry.member.ref)}
        host={mission.host}
        missionId={mission.mission.missionId}
        member={entry.member}
        machineLabel={machineLabel(entry.member.ref.environmentId)}
        missionName={mission.mission.name}
        onOpen={props.onOpenThread}
        toggle={toggle}
        hosts={hosts}
      />
    ) : (
      <Fragment key={scopedKey(entry.member.ref)}>
        {props.renderThreadRow(
          entry.thread,
          toggle,
          entry.member.state === "add-pending" || entry.member.state === "release-pending"
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
        <SidebarHeading
          action={
            <SidebarHeaderIconButton
              label={gt("New mission")}
              onClick={() =>
                openCommandPalette({ open: "new-thread-in", mission: { kind: "new" } })
              }
            >
              <PlusIcon />
            </SidebarHeaderIconButton>
          }
        >
          {gt("Missions", { $context: "sidebar section" })}
        </SidebarHeading>
      ) : null}
      {props.missions.map((mission) => {
        const expanded = missionExpandedById[mission.key] ?? true;
        const drop =
          props.dropTarget?.kind === "add" && props.dropTarget.mission === mission.key
            ? props.dropTarget
            : null;
        return (
          // The area a dragged thread drops on to join this mission.
          <li key={mission.key} className="list-none" data-mission-drop={mission.key}>
            <ul
              className={cn(
                "flex flex-col gap-px rounded-md",
                drop !== null && "bg-primary/5 ring-1 ring-primary/40",
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

/**
 * The shell stream leaves older settled threads out, a mission's lead among them. Each lead the
 * sidebar has no thread for is read in with its family, so its own row heads its mission, and is
 * kept while the mission is listed, so the row it brings in does not release it.
 */
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

// Keyed by a JSON array of scoped lead keys.
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

/**
 * The listed leads the shell left out whose family read has answered. That read brings every
 * thread it can, so a lead still missing after it is gone from the lists, as an archived one is.
 */
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

/**
 * Drops of the sidebar's thread drag on Missions. Over a Mission, the dragged threads join it;
 * a member dragged onto the thread list leaves its own. Each claims the pointer from sorting.
 */
export function useMissionDrop(missions: ReadonlyArray<SidebarMission<EnvironmentThreadShell>>) {
  const resolve = useMessages();
  const registry = useContext(RegistryContext);
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const menu = useMissionMenu();
  const [target, setTarget] = useState<MissionDrop | null>(null);
  type At = {
    readonly point: { readonly x: number; readonly y: number };
    /** The thread list the drag runs in. */
    readonly list: HTMLElement | null;
    readonly dragged: string | null;
    /** The dragged threads: the selection, when the drag started on a selected row. */
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  };
  const dropAt = ({ point, list, dragged, threads }: At) => {
    if (list === null || dragged === null || missions.length === 0) return null;
    const contains = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return (
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
      );
    };
    const mission = [...list.querySelectorAll<HTMLElement>("[data-mission-drop]")].find(contains);
    return resolveMissionDrop({
      dragged,
      threads,
      over: mission?.dataset.missionDrop ?? (contains(list) ? "list" : null),
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
      show(null);
      if (next === null) return false;
      if (next.refusal === null) {
        const refs = at.threads
          .map((thread) => scopeThreadRef(thread.environmentId, thread.id))
          .filter((ref) => next.kind === "add" || scopedThreadKey(ref) === at.dragged);
        void menu.run(`mission-${next.kind}:${next.host}:${next.missionId}`, refs);
      }
      return true;
    }),
    clear: useStableCallback(() => show(null)),
  };
}
