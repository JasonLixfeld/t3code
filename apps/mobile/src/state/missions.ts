import { useAtomValue } from "@effect/atom-react";
import {
  type MissionDraftIntent,
  type MissionHost,
  missionsLiveKey,
} from "@t3tools/client-runtime/missions";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { type MissionDraftTarget, useMissionDraft } from "./mission-drafts";
import {
  missionAdvertisers,
  missionDraftProjectMachines,
  missionDraftSend,
  resolveMissionPreferences,
} from "./missions.logic";
import { mobilePreferencesAtom } from "./preferences";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";

const missionPreferencesAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return resolveMissionPreferences(AsyncResult.isSuccess(preferences) ? preferences.value : null);
}).pipe(Atom.withLabel("mobile-mission-preferences"));

const missionAdvertisersAtom = Atom.make((get) =>
  missionAdvertisers(get(connectedEnvironmentIdsAtom), get(environmentServerConfigsAtom)),
).pipe(Atom.withLabel("mobile-mission-advertisers"));

const missionsTurnedOffAtom = Atom.make((get) => {
  const preferences = get(missionPreferencesAtom);
  return preferences.loaded && !preferences.enabled;
}).pipe(Atom.withLabel("mobile-missions-turned-off"));

const missionHostsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  const connected = get(missionAdvertisersAtom);
  const key = missionsLiveKey({
    enabled: get(missionPreferencesAtom).enabled,
    connected,
    readable: new Set(
      connected.filter((environmentId) =>
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environmentId)),
          AuthOrchestrationReadScope,
        ),
      ),
    ),
    descriptorOf: (environmentId) => configs.get(environmentId)?.environment,
  });
  return get(serverEnvironment.missionsLiveAcross(key));
}).pipe(Atom.withLabel("mobile-mission-hosts"));

const missionStartMachinesAtom = Atom.make(
  (get): ReadonlySet<EnvironmentId> =>
    new Set(
      get(missionHostsAtom)
        .map((host) => host.environmentId)
        .filter((environmentId) =>
          get(serverEnvironment.createMission.permissionAtom(environmentId)),
        ),
    ),
).pipe(Atom.withLabel("mobile-mission-start-machines"));

export function useMissionPreferences() {
  return useAtomValue(missionPreferencesAtom);
}

export function useMissionHosts(): ReadonlyArray<MissionHost> {
  return useAtomValue(missionHostsAtom);
}

export const readMissionHosts = () => appAtomRegistry.get(missionHostsAtom);

export function useMissionsAdvertised(): boolean {
  return useAtomValue(missionAdvertisersAtom).length > 0;
}

export function useMissionStartMachines(): ReadonlySet<EnvironmentId> {
  return useAtomValue(missionStartMachinesAtom);
}

export function useMissionDraftMachines(
  target: MissionDraftTarget | null,
): ReadonlySet<EnvironmentId> | null {
  return missionDraftProjectMachines({
    intent: useMissionDraft(target)?.intent,
    missionsOff: useAtomValue(missionsTurnedOffAtom),
    hosts: useMissionHosts(),
    startMachines: useMissionStartMachines(),
  });
}

const missionCommandOf = (intent: MissionDraftIntent) =>
  intent.kind === "new"
    ? serverEnvironment.createMission
    : intent.kind === "member"
      ? serverEnvironment.addMissionMember
      : serverEnvironment.setMissionLead;

export const readMissionDraftSend = (
  intent: MissionDraftIntent | undefined,
  environmentId: EnvironmentId,
) =>
  missionDraftSend({
    intent,
    environmentId,
    missionsOff: appAtomRegistry.get(missionsTurnedOffAtom),
    hosts: appAtomRegistry.get(missionHostsAtom),
    canRun: (marked, host) => appAtomRegistry.get(missionCommandOf(marked).permissionAtom(host)),
  });
