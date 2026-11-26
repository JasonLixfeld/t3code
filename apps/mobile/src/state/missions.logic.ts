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
