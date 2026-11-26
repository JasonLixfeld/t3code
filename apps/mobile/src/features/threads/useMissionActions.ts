import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  addEachToMission,
  claimHere,
  type MissionDraftIntent,
  missionAddSummary,
  missionLeaveId,
  type MissionMenuId,
  newMissionId,
  parseMissionTarget,
} from "@t3tools/client-runtime/missions";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  threadHasMessages,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react-native";
import { Platform } from "react-native";
import { useMemo } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { markMissionDraft, missionDraftOf } from "../../state/mission-drafts";
import { useMissionHosts, useMissionsLiveKey } from "../../state/missions";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import {
  MISSION_MEMBER_FORGET,
  MISSION_MEMBER_RELEASE,
  MISSION_MEMBER_RETRY,
  type MissionMenuContext,
  missingMemberMenuItems,
  missionLeadPick,
  missionMenuActions,
  threadMissionMenuItems,
} from "./missionMenus";
import type { ThreadListV2ListItem, ThreadListV2MissionPlace } from "./threadListV2";

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred."));
}

export function reportMissionFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
  retry?: () => void,
) {
  const message = failureMessage(result);
  if (message === null || isAtomCommandInterrupted(result)) return;
  Dialog.alert(
    title,
    message,
    retry === undefined
      ? undefined
      : [
          { text: m(msg("Cancel")), style: "cancel" },
          { text: m(msg("Try again")), onPress: retry },
        ],
  );
}

export function reportLeadOutcome(
  result: AtomCommandResult<unknown, unknown>,
  retry?: () => void,
): "done" | "lead-changed" | "failed" {
  if (result._tag === "Success") return "done";
  const error = squashAtomCommandFailure(result) as { readonly reason?: unknown } | null;
  if (error?.reason === "lead-changed") {
    Dialog.alert(m(msg("This mission already has a new lead")));
    return "lead-changed";
  }
  reportMissionFailure(m(msg("Could not make this thread the lead")), result, retry);
  return "failed";
}

const confirmed = (request: Omit<Dialog.ConfirmDialogRequest, "onConfirm" | "onCancel">) =>
  new Promise<boolean>((resolve) =>
    Dialog.confirm({ ...request, onConfirm: () => resolve(true), onCancel: () => resolve(false) }),
  );

const can = (right: "change" | "release" | "lead", environmentId: EnvironmentId) =>
  appAtomRegistry.get(
    (right === "change"
      ? serverEnvironment.addMissionMember
      : right === "release"
        ? serverEnvironment.releaseMissionMember
        : serverEnvironment.setMissionLead
    ).permissionAtom(environmentId),
  );

export function useMissionMenuContext(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): MissionMenuContext | null {
  const resolve = useMessages();
  const hosts = useMissionHosts();
  const { savedConnectionsById } = useSavedRemoteConnections();
  return useMemo(
    () =>
      hosts.length === 0
        ? null
        : {
            hosts,
            threads,
            resolve,
            can,
            machineLabel: (environmentId: EnvironmentId) =>
              savedConnectionsById[environmentId]?.environmentLabel ??
              hosts
                .flatMap((host) => host.snapshot.links)
                .find((link) => link.environmentId === environmentId)?.label ??
              environmentId,
          },
    [hosts, threads, resolve, savedConnectionsById],
  );
}

/** Puts each row's mission menu on its list item, so a row re-renders only when its menu changes. */
export function useMissionListMenus(
  items: ReadonlyArray<ThreadListV2ListItem>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ThreadListV2ListItem> {
  const ctx = useMissionMenuContext(threads);
  return useMemo(() => {
    if (ctx === null) return items;
    const menu = (rows: ReturnType<typeof threadMissionMenuItems>) => {
      const actions = missionMenuActions(rows, Platform.OS === "ios");
      return actions.length === 0 ? null : { key: JSON.stringify(actions), actions };
    };
    return items.map((item) =>
      item.type === "v2-thread"
        ? {
            ...item,
            missionMenu: menu(threadMissionMenuItems(item.item.thread, item.mission, ctx)),
          }
        : item.type === "v2-mission-member"
          ? { ...item, missionMenu: menu(missingMemberMenuItems(item.mission, ctx)) }
          : item,
    );
  }, [items, ctx]);
}

export interface MissionActionTarget {
  readonly thread: ScopedThreadRef;
  readonly place: ThreadListV2MissionPlace | null;
}

const shellOf = (ref: ScopedThreadRef) =>
  appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .find((shell) => shell.environmentId === ref.environmentId && shell.id === ref.threadId) ??
  null;

/** Runs a mission menu row. Reads the mission lists when it runs, so it keeps its identity. */
export function useMissionActions() {
  const gt = useGT();
  const resolve = useMessages();
  const liveKey = useMissionsLiveKey();
  const selectDetail = useSelectWorkspaceDetail();
  const create = useAtomCommand(serverEnvironment.createMission, "mission create");
  const add = useAtomCommand(serverEnvironment.addMissionMember, "mission add member");
  const leave = useAtomCommand(serverEnvironment.leaveMission, "mission leave");
  const release = useAtomCommand(serverEnvironment.releaseMissionMember, "mission release member");
  const forget = useAtomCommand(serverEnvironment.forgetMissionMember, "mission forget member");
  const deleteMission = useAtomCommand(serverEnvironment.deleteMission, "mission delete");
  const setLead = useAtomCommand(serverEnvironment.setMissionLead, "mission set lead");
  const hosts = () => appAtomRegistry.get(serverEnvironment.missionsLiveAcross(liveKey));
  const canChange = (environmentId: EnvironmentId) => can("change", environmentId);

  const openDraft = (
    lead: ScopedThreadRef,
    intent: Exclude<MissionDraftIntent, { kind: "new" }>,
  ) => {
    const home =
      shellOf(lead) ??
      appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .filter((shell) => shell.environmentId === intent.host && shell.archivedAt === null)
        .sort((left, right) =>
          (right.latestUserMessageAt ?? "").localeCompare(left.latestUserMessageAt ?? ""),
        )[0];
    if (home === undefined) {
      Dialog.alert(gt("No project on this machine yet"));
      return;
    }
    const requestId = uuidv4();
    markMissionDraft({ requestId }, intent);
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          requestId,
          environmentId: String(home.environmentId),
          projectId: String(home.projectId),
        },
      },
    });
  };

  const leaveNow = async (id: MissionMenuId, thread: ScopedThreadRef, confirm: boolean) => {
    const target = parseMissionTarget(id);
    if (target === null) return;
    if (target.action === "release") {
      reportMissionFailure(
        gt("Could not leave the mission"),
        await release({
          environmentId: target.environmentId,
          input: { missionId: target.missionId, member: thread },
        }),
      );
      return;
    }
    const claim = claimHere({ environmentId: thread.environmentId, id: thread.threadId }, hosts());
    if (
      confirm &&
      claim?.missionId === target.missionId &&
      !(await confirmed({
        title: gt('Leave the mission "{mission}"? Its lead will see that this thread left.', {
          mission: claim.name,
        }),
        confirmText: gt("Leave mission"),
      }))
    ) {
      return;
    }
    reportMissionFailure(
      gt("Could not leave the mission"),
      await leave({
        environmentId: target.environmentId,
        input: { threadId: thread.threadId, missionId: target.missionId },
      }),
    );
  };

  return async (id: string, { thread, place }: MissionActionTarget): Promise<void> => {
    if (id === "mission-start") {
      const shell = shellOf(thread);
      if (missionDraftOf(thread) !== undefined || (shell !== null && !threadHasMessages(shell))) {
        if (missionDraftOf(thread) === undefined) markMissionDraft(thread, { kind: "new" });
        selectDetail({
          name: "Thread",
          params: {
            environmentId: String(thread.environmentId),
            threadId: String(thread.threadId),
          },
        });
        Dialog.alert(gt("Sending starts a new mission led by this thread"));
        return;
      }
      reportMissionFailure(
        gt("Could not start the mission"),
        await create({
          environmentId: thread.environmentId,
          input: { missionId: newMissionId(), leadThreadId: thread.threadId },
        }),
      );
      return;
    }
    if (place !== null) {
      const command = {
        environmentId: place.host,
        input: { missionId: place.missionId, member: place.member.ref },
      };
      if (id === "mission-new-lead") {
        openDraft(place.member.ref, {
          kind: "lead",
          host: place.host,
          missionId: place.missionId,
          name: place.missionName,
          expectedLead: place.member.ref.threadId,
        });
        return;
      }
      if (id === MISSION_MEMBER_RETRY) {
        const retry = missionLeaveId(
          { environmentId: thread.environmentId, id: thread.threadId },
          { host: place.host, mission: { missionId: place.missionId } },
          hosts(),
          canChange,
          place.missionId,
        );
        if (retry !== null) await leaveNow(retry, thread, false);
        return;
      }
      if (id === MISSION_MEMBER_FORGET) {
        if (
          place.member.state !== "release-refused" &&
          !(await confirmed({
            title: gt(
              "Forget this thread? Nothing is sent to its machine. If that machine comes back still holding the thread, someone there can free it with Leave mission.",
            ),
            confirmText: gt("Forget"),
          }))
        ) {
          return;
        }
        reportMissionFailure(gt("Could not forget the thread"), await forget(command));
        return;
      }
      if (id === MISSION_MEMBER_RELEASE) {
        reportMissionFailure(gt("Could not leave the mission"), await release(command));
        return;
      }
      const lead = missionLeadPick(id);
      if (lead !== null) {
        reportLeadOutcome(
          await setLead({
            environmentId: place.host,
            input: {
              missionId: place.missionId,
              lead: { environmentId: place.host, threadId: ThreadId.make(lead) },
              expectedLead: place.member.ref.threadId,
            },
          }),
        );
        return;
      }
    }
    const target = parseMissionTarget(id as MissionMenuId);
    if (target === null) return;
    const mission = hosts()
      .find((host) => host.environmentId === target.environmentId)
      ?.snapshot.missions.find((candidate) => candidate.missionId === target.missionId);
    switch (target.action) {
      case "leave":
      case "release":
        await leaveNow(id as MissionMenuId, thread, true);
        return;
      case "new-thread":
        if (mission !== undefined) {
          openDraft(thread, {
            kind: "member",
            host: target.environmentId,
            missionId: target.missionId,
            name: mission.name,
          });
        }
        return;
      case "delete":
        if (
          mission === undefined ||
          !(await confirmed({
            title: gt('Delete the mission "{mission}"? Its lead stays as a thread of its own.', {
              mission: mission.name,
            }),
            confirmText: gt("Delete mission"),
            destructive: true,
          }))
        ) {
          return;
        }
        reportMissionFailure(
          gt("Could not delete the mission"),
          await deleteMission({
            environmentId: target.environmentId,
            input: { missionId: target.missionId },
          }),
        );
        return;
      case "add": {
        const outcome = await addEachToMission([thread], async (member) =>
          failureMessage(
            await add({
              environmentId: target.environmentId,
              input: { missionId: target.missionId, member },
            }),
          ),
        );
        const summary = missionAddSummary(outcome, resolve);
        if (summary !== null) Dialog.alert(summary);
        return;
      }
      case "prompt":
        return;
    }
  };
}
