import { RegistryContext } from "@effect/atom-react";
import type { MissionHost } from "@t3tools/client-runtime/missions";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type MissionMember,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { missingMemberMenuItems } from "../features/threads/missionMenus";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
} from "../features/threads/threadListV2";
import { m } from "../i18n/messages";
import { makeRawThreadShell, makeThreadShellFixture } from "../test-fixtures";
import { appAtomRegistry } from "./atom-registry";
import { useMissionLeadShells } from "./mission-leads";
import { environmentThreadShells, threadFamilies } from "./threads";

const mounts = vi.hoisted(() => new Map<string, number>());

vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./threads", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const families = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>>(
      AsyncResult.initial(),
    ).pipe(Atom.keepAlive),
  );
  const indexes = Atom.family((_environmentId: string) =>
    Atom.make<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>(new Map()).pipe(Atom.keepAlive),
  );
  return {
    threadFamilies: {
      familyAtom: (environmentId: string, threadId: string) =>
        families(`${environmentId}:${threadId}`),
      mount: (_registry: unknown, environmentId: string, threadId: string) => {
        const key = `${environmentId}:${threadId}`;
        mounts.set(key, (mounts.get(key) ?? 0) + 1);
        return () => mounts.set(key, (mounts.get(key) ?? 0) - 1);
      },
    },
    environmentThreadShells: { environmentThreadIndexAtom: indexes },
  };
});

const DESK = EnvironmentId.make("env-desk");
const NOW = "2026-11-26T00:00:00.000Z";
const lead = (threadId: string): MissionMember => ({
  ref: { environmentId: DESK, threadId: ThreadId.make(threadId) },
  role: "lead",
  state: "active",
});
const hostWith = (leads: ReadonlyArray<string>): ReadonlyArray<MissionHost> => [
  {
    environmentId: DESK,
    snapshot: {
      links: [],
      claims: [],
      missions: leads.map((threadId) => ({
        missionId: `m-${threadId}`,
        name: `Mission ${threadId}`,
        createdAt: NOW,
        members: [lead(threadId)],
      })),
    },
  },
];
const settle = (threadId: string, rows: ReadonlyArray<string> = []) =>
  appAtomRegistry.set(
    threadFamilies.familyAtom(DESK, ThreadId.make(threadId)) as Atom.Writable<
      AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>
    >,
    AsyncResult.success({
      snapshotSequence: 1,
      threads: rows.map((id) => makeRawThreadShell({ id: ThreadId.make(id) })),
    }),
  );

let root: ReturnType<typeof createRoot>;
let missing: ReadonlySet<string> = new Set();

function Probe(props: {
  readonly hosts: ReadonlyArray<MissionHost>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  missing = useMissionLeadShells(props.hosts, props.threads);
  return null;
}
const render = (
  hosts: ReadonlyArray<MissionHost>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) =>
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe hosts={hosts} threads={threads} />
      </RegistryContext.Provider>,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  mounts.clear();
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useMissionLeadShells", () => {
  it("keeps a loaded lead's family mounted, and releases it once no mission wants it", () => {
    const hosts = hostWith(["far"]);
    render(hosts, []);
    expect(mounts.get(`${DESK}:far`)).toBe(1);

    settle("far", ["far"]);
    render(hosts, [makeThreadShellFixture({ environmentId: DESK, id: ThreadId.make("far") })]);
    expect(mounts.get(`${DESK}:far`)).toBe(1);
    expect(missing.size).toBe(0);

    render([], []);
    expect(mounts.get(`${DESK}:far`)).toBe(0);
  });

  it("offers lead recovery only for a lead that no read holds, not for a hidden one", () => {
    const hosts = hostWith(["hidden", "family", "gone"]);
    appAtomRegistry.set(
      environmentThreadShells.environmentThreadIndexAtom(DESK) as Atom.Writable<
        ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>
      >,
      new Map([[ThreadId.make("hidden"), makeRawThreadShell({ id: ThreadId.make("hidden") })]]),
    );
    settle("hidden");
    settle("family", ["family"]);
    settle("gone");
    render(hosts, []);
    expect([...missing]).toEqual([`${DESK}:gone`]);

    const built = buildThreadListV2Items({
      threads: [],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      missionHosts: hosts,
      settledMissingMissionLeadKeys: missing,
    });
    const recovery = buildThreadListV2ListItems({
      items: built.items,
      missions: built.missions,
      pendingTasks: [],
    }).flatMap((item) =>
      item.type === "v2-mission-member"
        ? [
            [
              item.mission.member.ref.threadId,
              missingMemberMenuItems(item.mission, {
                hosts,
                threads: [],
                machineLabel: () => "Desk",
                can: () => true,
                resolve: m,
              }).some((row) => row.id === "mission-new-lead"),
            ],
          ]
        : [],
    );
    expect(recovery).toEqual([
      ["hidden", false],
      ["family", false],
      ["gone", true],
    ]);
  });
});
