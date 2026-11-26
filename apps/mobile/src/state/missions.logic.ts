import {
  type MissionDraftIntent,
  missionDraftMachines,
  type MissionHost,
} from "@t3tools/client-runtime/missions";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

export function resolveMissionPreferences(preferences: Preferences | null) {
  return {
    loaded: preferences !== null,
    enabled: preferences?.missionsEnabled !== false,
    headerVisible: preferences?.missionsHeaderVisible !== false,
    threadsHeaderVisible: preferences?.threadsHeaderVisible !== false,
  };
}

export const missionAdvertisers = (
  connected: ReadonlyArray<EnvironmentId>,
  configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "environment">>,
) =>
  connected.filter(
    (environmentId) => configs.get(environmentId)?.environment.capabilities.missions === true,
  );

export function missionDraftProjectMachines(input: {
  readonly intent: MissionDraftIntent | undefined;
  readonly missionsOff: boolean;
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly startMachines: ReadonlySet<EnvironmentId>;
}): ReadonlySet<EnvironmentId> | null {
  const { intent } = input;
  if (intent === undefined || input.missionsOff) return null;
  if (intent.kind === "new") return input.startMachines;
  // Links the operator cannot see cannot be checked, so only the mission's own machine is safe.
  return missionDraftMachines(intent, input.hosts) ?? new Set([intent.host]);
}

export type MissionDraftSend =
  | { readonly kind: "plain" }
  | { readonly kind: "turned-off" }
  | { readonly kind: "mission" }
  | { readonly kind: "machine-refused" }
  | { readonly kind: "offline"; readonly host: EnvironmentId }
  | { readonly kind: "not-allowed" };

/** Only the user's own setting turns a mark off; a server that is offline or loading refuses. */
export function missionDraftSend(input: {
  readonly intent: MissionDraftIntent | undefined;
  readonly missionsOff: boolean;
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly environmentId: EnvironmentId;
  readonly canRun: (intent: MissionDraftIntent, host: EnvironmentId) => boolean;
}): MissionDraftSend {
  const { intent, environmentId } = input;
  if (intent === undefined) return { kind: "plain" };
  if (input.missionsOff) return { kind: "turned-off" };
  const host = intent.kind === "new" ? environmentId : intent.host;
  if (!input.hosts.some((candidate) => candidate.environmentId === host)) {
    return { kind: "offline", host };
  }
  if (
    intent.kind !== "new" &&
    !(missionDraftMachines(intent, input.hosts) ?? new Set([intent.host])).has(environmentId)
  ) {
    return { kind: "machine-refused" };
  }
  return input.canRun(intent, host) ? { kind: "mission" } : { kind: "not-allowed" };
}

export const missionDraftAllows = (
  machines: ReadonlySet<EnvironmentId> | null,
  environmentId: EnvironmentId,
) => machines === null || machines.has(environmentId);

export function canStartMission(
  startMachines: ReadonlySet<EnvironmentId>,
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "workspaceRoot" | "isScratch" | "archivedAt">
  >,
  scratchRootFor: (environmentId: EnvironmentId) => string | null,
): boolean {
  return (
    [...startMachines].some((environmentId) => scratchRootFor(environmentId) !== null) ||
    projects.some(
      (project) =>
        project.archivedAt == null &&
        startMachines.has(project.environmentId) &&
        !isScratchProject(project, scratchRootFor(project.environmentId)),
    )
  );
}
