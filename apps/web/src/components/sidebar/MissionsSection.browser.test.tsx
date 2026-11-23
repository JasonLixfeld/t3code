import {
  EnvironmentId,
  type LocalApi,
  MissionError,
  ProjectId,
  ThreadId,
  type Mission,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MissionHost } from "./missions.logic";
import { MissionsSection } from "./MissionsSection";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const BOX = EnvironmentId.make("env-box");
const ref = (environmentId: EnvironmentId, threadId: string) => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});
const ship: Mission = {
  missionId: "0123456789ab",
  name: "Ship v2 release",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [
    { ref: ref(DESK, "lead"), role: "lead", addedAt: "2026-11-23T00:00:00.000Z" },
    { ref: ref(DESK, "docs"), role: "member", addedAt: "2026-11-23T00:01:00.000Z" },
    { ref: ref(LAPTOP, "ios"), role: "member", addedAt: "2026-11-23T00:02:00.000Z" },
  ],
};
const audit: Mission = {
  missionId: "ba9876543210",
  name: "Security audit",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [{ ref: ref(LAPTOP, "audit"), role: "lead", addedAt: "2026-11-23T00:00:00.000Z" }],
};
const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: {
      missions: [ship],
      links: [
        { environmentId: LAPTOP, label: "Laptop", fullAccess: true },
        { environmentId: BOX, label: "Build box", fullAccess: false },
      ],
    },
  },
  {
    environmentId: LAPTOP,
    snapshot: {
      missions: [audit],
      links: [{ environmentId: BOX, label: "Build box", fullAccess: true }],
    },
  },
];
const titles: Record<string, [string, string]> = {
  lead: ["Plan the v2 release", "t3code"],
  docs: ["Update the release notes", "docs-site"],
  ios: ["Fix the iOS share sheet", "mobile"],
};
const labels: Record<string, string> = {
  "env-desk": "Desk",
  "env-laptop": "Laptop",
  "env-box": "Build box",
};

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      missionsLiveAcross: () => Atom.make([...hosts]),
      releaseMissionMember: Object.assign(actual.serverEnvironment.releaseMissionMember, {
        permissionAtom: () => Atom.make(true),
      }),
    },
  };
});
vi.mock("../../localApi", { spy: true });
vi.mock("../../state/use-atom-command", { spy: true });
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useConnectedEnvironmentIds: () => [DESK, LAPTOP],
  useEnvironmentIdentities: () =>
    Object.entries(labels).map(([environmentId, label]) => ({
      environmentId: EnvironmentId.make(environmentId),
      label,
    })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (target) => {
    const known = target === null ? undefined : titles[target.threadId];
    return known === undefined
      ? null
      : ({
          title: known[0],
          environmentId: target!.environmentId,
          projectId: ProjectId.make(known[1]),
        } as never);
  },
  useProject: (target) => (target === null ? null : ({ title: target.projectId } as never)),
}));

it("lists each mission with its lead first, and offers release only for members", async () => {
  await using screen = await render(<MissionsSection onOpenThread={() => {}} />);
  const rows = screen.container.querySelectorAll("li li");
  expect([...rows].map((row) => row.textContent)).toEqual([
    "LeadPlan the v2 releaseDesk · t3code",
    "Update the release notesDesk · docs-site",
    "Fix the iOS share sheetLaptop · mobile",
    "LeadThread on LaptopLaptop",
  ]);
  expect(screen.getByRole("button", { name: "Release from mission" }).elements()).toHaveLength(2);
});

const releaseFailing = (error: MissionError) => {
  const calls: Array<unknown> = [];
  vi.mocked(useAtomCommand).mockImplementation(
    () =>
      (async (value: { readonly input: { readonly leaveTag?: boolean } }) => {
        calls.push(value.input);
        return value.input.leaveTag === true
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(error));
      }) as never,
  );
  vi.mocked(readLocalApi).mockReturnValue({
    dialogs: { confirm: async () => true },
  } as unknown as LocalApi);
  return calls;
};

it("offers removing anyway only after a release could not reach the member's machine", async () => {
  const calls = releaseFailing(
    new MissionError({ message: "Laptop did not answer.", reason: "unreachable" }),
  );
  await using screen = await render(<MissionsSection onOpenThread={() => {}} />);
  const anyway = screen.getByRole("button", { name: "Remove from mission anyway" });
  expect(anyway.elements()).toHaveLength(0);

  await userEvent.click(screen.getByRole("button", { name: "Release from mission" }).nth(1));
  await expect.element(anyway).toBeVisible();
  await userEvent.click(anyway);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({ leaveTag: true });
});

it("does not offer removing anyway when the member's machine refused", async () => {
  releaseFailing(new MissionError({ message: "No." }));
  await using screen = await render(<MissionsSection onOpenThread={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Release from mission" }).nth(1));
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Release from mission" }).nth(1).element(),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("button", { name: "Remove from mission anyway" }).elements(),
  ).toHaveLength(0);
});
