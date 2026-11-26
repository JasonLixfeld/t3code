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
  readonly missionsOn: boolean;
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly startMachines: ReadonlySet<EnvironmentId>;
}): ReadonlySet<EnvironmentId> | null {
  const { intent } = input;
  if (intent === undefined || !input.missionsOn) return null;
  if (intent.kind === "new") return input.startMachines;
  // Links the operator cannot see cannot be checked, so only the mission's own machine is safe.
  return missionDraftMachines(intent, input.hosts) ?? new Set([intent.host]);
}

/** "drop": Missions are off, so the mark is cleared and the draft sends as a plain thread. */
export function missionDraftSend(
  input: Parameters<typeof missionDraftProjectMachines>[0] & {
    readonly environmentId: EnvironmentId;
  },
): "plain" | "drop" | "mission" | "refused" {
  if (input.intent === undefined) return "plain";
  if (!input.missionsOn) return "drop";
  return missionDraftProjectMachines(input)?.has(input.environmentId) === true
    ? "mission"
    : "refused";
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
