import {
  type MissionDraftIntent,
  missionDraftMachines,
  type MissionHost,
} from "@t3tools/client-runtime/missions";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

/** The web's sidebar Missions settings, which default to on. */
export function resolveMissionPreferences(preferences: Preferences | null) {
  return {
    loaded: preferences !== null,
    enabled: preferences?.missionsEnabled !== false,
    headerVisible: preferences?.missionsHeaderVisible !== false,
    threadsHeaderVisible: preferences?.threadsHeaderVisible !== false,
  };
}

export const missionsAdvertised = (
  connected: ReadonlyArray<EnvironmentId>,
  configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "environment">>,
) =>
  connected.some(
    (environmentId) => configs.get(environmentId)?.environment.capabilities.missions === true,
  );

/** The machines a mission draft may start on; null leaves every machine open. */
export function missionDraftProjectMachines(
  intent: MissionDraftIntent | undefined,
  hosts: ReadonlyArray<MissionHost>,
  startMachines: ReadonlySet<EnvironmentId>,
): ReadonlySet<EnvironmentId> | null {
  if (intent === undefined) return null;
  return intent.kind === "new" ? startMachines : missionDraftMachines(intent, hosts);
}

/** The web's "New mission…" rule: a machine may start one and has a project or a "No project" home. */
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
