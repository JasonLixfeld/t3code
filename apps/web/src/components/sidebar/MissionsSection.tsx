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
import { ChevronDownIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode, useContext, useState } from "react";

import { m } from "../../i18n/messages";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentIdentities, useConnectedEnvironmentIds } from "../../state/environments";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import type { SidebarMission } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addEachToMission,
  buildMissionMenuItems,
  claimHere,
  missionAddSummary,
  type MissionCandidate,
  type MissionHost,
  type MissionMenuId,
  parseMissionAddId,
} from "./missions.logic";
import { SidebarHeading } from "./SidebarListMarkers";
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

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
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
      const target = parseMissionAddId(id);
      if (target === null) return [];
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
const newMissionId = () => SecureRandom.uuidV4Unsafe().replaceAll("-", "").slice(0, 12);

function MemberRow(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly member: MissionMember;
  readonly machineLabel: string;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  /** Set on a lead row this client has no thread for, so it still folds its members. */
  readonly toggle?: SidebarMissionToggle | undefined;
}) {
  const gt = useGT();
  const thread = useQuietThreadShell(props.member.ref);
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
    : (thread?.title ?? gt("Thread on {machine}", { machine: props.machineLabel }));
  const where = project === null ? props.machineLabel : `${props.machineLabel} · ${project.title}`;
  const active = props.member.state === "active";
  // A refused add never joined, so its button only puts the refusal away.
  const dismisses = props.member.state === "add-refused";
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
  return (
    <li className="group/mission-row list-none">
      <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-sidebar-row-hover">
        {toggle ? (
          <button
            type="button"
            aria-expanded={toggle.expanded}
            aria-label={toggle.expanded ? gt("Collapse mission") : gt("Expand mission")}
            onClick={toggle.onToggle}
            className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground hover:text-sidebar-foreground"
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
            <span className="truncate">{title}</span>
            {toggle && !toggle.expanded && toggle.memberCount > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                {toggle.memberCount}
              </span>
            ) : null}
          </span>
          <span className="truncate text-2xs text-sidebar-muted-foreground">
            {props.member.state === "release-pending"
              ? gt("Release pending (machine offline)")
              : props.member.state === "add-pending"
                ? gt("Add pending (machine offline)")
                : props.member.state === "add-refused"
                  ? props.member.detail
                  : props.member.state === "offline"
                    ? gt("Last known (machine offline)")
                    : where}
          </span>
        </button>
        {props.member.role === "member" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    forgets ? gt("Forget") : dismisses ? gt("Dismiss") : gt("Release from mission")
                  }
                  disabled={!canRelease || releasing}
                  onClick={() => void onRelease()}
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
        ) : null}
      </div>
    </li>
  );
}

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
  ) => ReactNode;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
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
        onOpen={props.onOpenThread}
        toggle={toggle}
      />
    ) : (
      <Fragment key={scopedKey(entry.member.ref)}>
        {props.renderThreadRow(entry.thread, toggle)}
      </Fragment>
    );
  return (
    <>
      {props.headerVisible ? (
        <SidebarHeading>{gt("Missions", { $context: "sidebar section" })}</SidebarHeading>
      ) : null}
      {props.missions.map((mission) => {
        const expanded = missionExpandedById[mission.key] ?? true;
        return (
          <Fragment key={mission.key}>
            {row(mission, mission.lead, {
              expanded,
              memberCount: mission.members.length,
              onToggle: () => setMissionExpanded(mission.key, !expanded),
            })}
            {expanded && mission.members.length > 0 ? (
              <li className="list-none" data-testid="sidebar-mission-members">
                <ul className="ms-3 flex flex-col gap-px border-s border-sidebar-border ps-1">
                  {mission.members.map((entry) => row(mission, entry))}
                </ul>
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}

const scopedKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
