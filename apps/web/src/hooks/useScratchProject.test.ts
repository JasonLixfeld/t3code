import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createScratchProjectActions } from "./useScratchProject";

const openScratch = vi.hoisted(() => ({ interrupted: false }));

vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      openScratch: {
        label: "open scratch project",
        run: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => (openScratch.interrupted = true))),
          ),
      },
    },
  };
});

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(environmentId: EnvironmentId, scratchWorkspaceRoot: string | null) {
  return {
    environmentId,
    connection: { phase: "connected" },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });
});

describe("openScratchProject", () => {
  it("hands its caller's abort signal to the command, so an abort frees the machine's queue", async () => {
    const controller = new AbortController();
    const opening = actions(local, "/local/scratch").openScratchProject(
      local,
      undefined,
      controller.signal,
    );
    controller.abort();
    expect(await opening).toBeNull();
    expect(openScratch.interrupted).toBe(true);
  });
});
