import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Mission, MissionMember, ScopedThreadRef } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { m } from "../../i18n/messages";
import { useEnvironmentIdentities, useConnectedEnvironmentIds } from "../../state/environments";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildMissionMenuItems,
  type MissionCandidate,
  type MissionHost,
  type MissionMenuId,
  parseMissionAddId,
} from "./missions.logic";

function useMissionHosts(): ReadonlyArray<MissionHost> {
  const environmentIds = useConnectedEnvironmentIds();
  return useAtomValue(serverEnvironment.missionsLiveAcross(JSON.stringify(environmentIds)));
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

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
    }),
  );
  return true;
}

/** The Mission entries of a thread menu, and what choosing one does. */
export function useMissionMenu() {
  const gt = useGT();
  const resolve = useMessages();
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const create = useAtomCommand(serverEnvironment.createMission, "mission create");
  const add = useAtomCommand(serverEnvironment.addMissionMember, "mission add member");
  return {
    items: (threads: ReadonlyArray<MissionCandidate>) =>
      buildMissionMenuItems(threads, hosts, machineLabel, resolve),
    run: async (id: MissionMenuId, threads: ReadonlyArray<ScopedThreadRef>) => {
      const lead = threads[0];
      if (id === "mission-start" && lead !== undefined) {
        const name = await requestMissionName();
        if (name === null) return;
        reportFailure(
          gt("Could not start the mission"),
          await create({
            environmentId: lead.environmentId,
            input: { name, leadThreadId: lead.threadId },
          }),
        );
        return;
      }
      const target = parseMissionAddId(id);
      if (target === null) return;
      for (const member of threads) {
        const failed = reportFailure(
          gt("Could not add the thread to the mission"),
          await add({
            environmentId: target.environmentId,
            input: { missionId: target.missionId, member },
          }),
        );
        if (failed) return;
      }
    },
  };
}

function MemberRow(props: {
  readonly host: EnvironmentId;
  readonly missionId: string;
  readonly member: MissionMember;
  readonly machineLabel: string;
  readonly onOpen: (ref: ScopedThreadRef) => void;
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
  const [releasing, setReleasing] = useState(false);
  const title = thread?.title ?? gt("Thread on {machine}", { machine: props.machineLabel });
  const where = project === null ? props.machineLabel : `${props.machineLabel} · ${project.title}`;
  const onRelease = async () => {
    setReleasing(true);
    reportFailure(
      gt("Could not release the thread"),
      await release({
        environmentId: props.host,
        input: { missionId: props.missionId, member: props.member.ref },
      }),
    );
    setReleasing(false);
  };
  return (
    <li className="group/mission-row list-none">
      <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-sidebar-row-hover">
        <button
          type="button"
          disabled={thread === null}
          onClick={() => props.onOpen(props.member.ref)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col text-left disabled:cursor-default"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-sidebar-foreground">
            {props.member.role === "lead" ? (
              <span className="shrink-0 text-2xs font-medium text-sidebar-muted-foreground uppercase">
                <T context="the thread that leads a mission">Lead</T>
              </span>
            ) : null}
            <span className="truncate">{title}</span>
          </span>
          <span className="truncate text-2xs text-sidebar-muted-foreground">{where}</span>
        </button>
        {props.member.role === "member" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Release from mission")}
                  disabled={!canRelease || releasing}
                  onClick={() => void onRelease()}
                  className="inline-flex shrink-0 cursor-pointer items-center rounded-md px-1 text-muted-foreground opacity-0 transition-opacity group-hover/mission-row:opacity-100 hover:text-foreground focus-visible:opacity-100 disabled:cursor-default"
                >
                  <XIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">
              <T>Release from mission</T>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </li>
  );
}

function MissionGroup(props: {
  readonly host: EnvironmentId;
  readonly mission: Mission;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  return (
    <li className="list-none">
      <div className="truncate px-2 pt-1 text-xs font-medium text-secondary-label">
        {props.mission.name}
      </div>
      <ul>
        {props.mission.members.map((member) => (
          <MemberRow
            key={`${member.ref.environmentId}:${member.ref.threadId}`}
            host={props.host}
            missionId={props.mission.missionId}
            member={member}
            machineLabel={props.machineLabel(member.ref.environmentId)}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
    </li>
  );
}

/** Missions across connected machines: each lists its lead first, then its members. */
export function MissionsSection(props: { readonly onOpenThread: (ref: ScopedThreadRef) => void }) {
  const gt = useGT();
  const hosts = useMissionHosts();
  const machineLabel = useMachineLabel(hosts);
  const [expanded, setExpanded] = useState(true);
  const missions = hosts.flatMap((host) =>
    host.snapshot.missions.map((mission) => ({ host: host.environmentId, mission })),
  );
  if (missions.length === 0) return null;
  return (
    <div className="mx-0.5 mb-1" data-testid="sidebar-missions">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        accessory={<span className="font-normal tabular-nums">{missions.length}</span>}
      >
        {gt("Missions", { $context: "sidebar section" })}
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul>
          {missions.map(({ host, mission }) => (
            <MissionGroup
              key={`${host}:${mission.missionId}`}
              host={host}
              mission={mission}
              machineLabel={machineLabel}
              onOpen={props.onOpenThread}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type NameRequest = { readonly resolve: (name: string | null) => void };
const useNameRequest = create<{ request: NameRequest | null }>(() => ({ request: null }));

function requestMissionName(): Promise<string | null> {
  useNameRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useNameRequest.setState({ request: { resolve } }));
}

function finishNameRequest(name: string | null) {
  const request = useNameRequest.getState().request;
  useNameRequest.setState({ request: null });
  request?.resolve(name);
}

export function MissionNameDialogHost() {
  const request = useNameRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending name request with null when the host unmounts
  useEffect(() => () => finishNameRequest(null), []);
  return request ? <MissionNameDialog /> : null;
}

function MissionNameDialog() {
  const gt = useGT();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finishNameRequest(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") finishNameRequest(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Start mission</T>
            </DialogTitle>
            <DialogDescription>
              <T>This thread leads the mission. Add other threads to it from their menus.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              aria-label={gt("Mission name")}
              placeholder={gt("Mission name")}
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finishNameRequest(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmed === ""}>
              <T context="verb, start a mission">Start</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
