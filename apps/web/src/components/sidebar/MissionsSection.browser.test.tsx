import { EnvironmentId, ProjectId, ThreadId, type Mission } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
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
    { ref: ref(DESK, "lead"), role: "lead", state: "active" },
    { ref: ref(DESK, "docs"), role: "member", state: "active" },
    { ref: ref(LAPTOP, "ios"), role: "member", state: "offline" },
    { ref: ref(LAPTOP, "old"), role: "member", state: "release-pending" },
    { ref: ref(LAPTOP, "new"), role: "member", state: "add-pending" },
    { ref: ref(LAPTOP, "taken"), role: "member", state: "add-refused", detail: "Laptop refused." },
  ],
};
const audit: Mission = {
  missionId: "ba9876543210",
  name: "Security audit",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [{ ref: ref(LAPTOP, "audit"), role: "lead", state: "active" }],
};
const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: {
      missions: [ship],
      claims: [],
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
      claims: [],
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

it("lists each mission with its lead first, and offers release unless something is still pending", async () => {
  await using screen = await render(<MissionsSection onOpenThread={() => {}} />);
  const rows = screen.container.querySelectorAll("li li");
  expect([...rows].map((row) => row.textContent)).toEqual([
    "LeadPlan the v2 releaseDesk · t3code",
    "Update the release notesDesk · docs-site",
    "Fix the iOS share sheetLast known (machine offline)",
    "Thread on LaptopRelease pending (machine offline)",
    "Thread on LaptopAdd pending (machine offline)",
    "Thread on LaptopLaptop refused.",
    "LeadThread on LaptopLaptop",
  ]);
  expect(screen.getByRole("button", { name: "Release from mission" }).elements()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Dismiss" }).elements()).toHaveLength(1);
});
