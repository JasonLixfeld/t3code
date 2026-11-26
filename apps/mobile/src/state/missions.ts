import { useAtomValue } from "@effect/atom-react";
import { type MissionHost, missionsLiveKey } from "@t3tools/client-runtime/missions";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "./entities";
import { useMissionDraft } from "./mission-drafts";
import {
  missionDraftProjectMachines,
  missionsAdvertised,
  resolveMissionPreferences,
} from "./missions.logic";
import { mobilePreferencesAtom } from "./preferences";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { serverEnvironment } from "./server";
import { useEnvironmentsWithScope } from "./session";

export function useMissionPreferences() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveMissionPreferences(AsyncResult.isSuccess(preferences) ? preferences.value : null);
}

/** The key of `missionsLiveAcross` for this client: stable while the mission lists tick. */
export function useMissionsLiveKey(): string {
  const { enabled } = useMissionPreferences();
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const configs = useServerConfigs();
  const readable = useEnvironmentsWithScope(
    connected.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  return missionsLiveKey({
    enabled,
    connected,
    readable,
    descriptorOf: (environmentId) => configs.get(environmentId)?.environment,
  });
}

/** The connected servers' Missions lists. Empty while Missions are off or no server serves them. */
export function useMissionHosts(): ReadonlyArray<MissionHost> {
  return useAtomValue(serverEnvironment.missionsLiveAcross(useMissionsLiveKey()));
}

/** Whether Settings offers Missions: some connected server says it serves them. */
export function useMissionsAdvertised(): boolean {
  return missionsAdvertised(useAtomValue(connectedEnvironmentIdsAtom), useServerConfigs());
}

const missionCreatePermissionsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? []
      : key
          .split("\n")
          .map((environmentId) =>
            get(serverEnvironment.createMission.permissionAtom(environmentId as EnvironmentId)),
          ),
  ).pipe(Atom.withLabel(`mobile-mission-create-permissions:${key}`)),
);

/** The mission hosts where this client may start a mission. */
export function useMissionStartMachines(
  hosts: ReadonlyArray<MissionHost>,
): ReadonlySet<EnvironmentId> {
  const permissions = useAtomValue(
    missionCreatePermissionsAtom(hosts.map((host) => host.environmentId).join("\n")),
  );
  return new Set(
    hosts.flatMap((host, index) => (permissions[index] === true ? [host.environmentId] : [])),
  );
}

/** The machines a draft route's projects may come from while its mission mark lasts. */
export function useMissionDraftMachines(
  requestId: string | null,
): ReadonlySet<EnvironmentId> | null {
  const { enabled } = useMissionPreferences();
  const hosts = useMissionHosts();
  const startMachines = useMissionStartMachines(hosts);
  const intent = useMissionDraft(requestId, null)?.intent;
  return enabled ? missionDraftProjectMachines(intent, hosts, startMachines) : null;
}
