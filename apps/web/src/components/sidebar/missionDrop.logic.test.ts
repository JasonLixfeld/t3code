import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  MissionCandidate,
  MissionHost,
  SidebarMission,
} from "@t3tools/client-runtime/missions";
import {
  EnvironmentId,
  type Mission,
  type MissionLink,
  type MissionMember,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMissionDrop } from "./missionDrop.logic";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const BOX = EnvironmentId.make("env-box");

const mission: Mission = {
  missionId: "0123456789ab",
  name: "Ship v2",
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [],
};
const links: ReadonlyArray<MissionLink> = [
  { environmentId: LAPTOP, label: "Laptop", fullAccess: true },
  { environmentId: BOX, label: "Box", fullAccess: false },
];
const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: {
      missions: [mission],
      links,
      claims: [{ threadId: ThreadId.make("held"), missionId: "ffffffffffff", name: "Theirs" }],
    },
  },
];
const label = (environmentId: EnvironmentId) =>
  environmentId === DESK ? "Desk" : String(environmentId);
const allowed = () => true;
const thread = (environmentId: EnvironmentId, id?: string) => ({
  environmentId,
  ...(id === undefined ? {} : { id: ThreadId.make(id) }),
  latestUserMessageAt: "2026-11-23T00:00:00.000Z",
  visibleItemCount: 1,
});

describe("resolveMissionDrop", () => {
  const docs = { environmentId: DESK, threadId: ThreadId.make("docs") };
  const sidebarMission = (missionId: string, members: ReadonlyArray<MissionMember>) => {
    const entries = members.map((member) => ({ member, thread: {} }));
    return {
      key: `${DESK}:${missionId}`,
      host: DESK,
      mission: { ...mission, missionId, members },
      lead: entries[0]!,
      leadInScope: true,
      members: entries.slice(1),
    } satisfies SidebarMission<unknown>;
  };
  const lead = (id: string): MissionMember => ({
    ref: { environmentId: DESK, threadId: ThreadId.make(id) },
    role: "lead",
    state: "active",
  });
  const ship = sidebarMission(mission.missionId, [
    lead("lead"),
    { ref: docs, role: "member", state: "active" },
  ]);
  const other = sidebarMission("bbbbbbbbbbbb", [lead("other-lead")]);
  const drop = (
    over: string,
    options: {
      readonly source?: { readonly host: EnvironmentId; readonly missionId: string };
      readonly canChangeOn?: (environmentId: EnvironmentId) => boolean;
      readonly threads?: ReadonlyArray<MissionCandidate>;
    } = {},
  ) =>
    resolveMissionDrop({
      dragged: scopedThreadKey(docs),
      threads: options.threads ?? [thread(DESK, "docs")],
      over,
      missions: [ship, other],
      hosts,
      machineLabel: label,
      canChangeOn: options.canChangeOn ?? allowed,
      source: options.source ?? null,
    });

  it("refuses a release when the thread moved to another mission on the same machine", () => {
    expect(drop("list", { source: { host: DESK, missionId: ship.mission.missionId } })).toEqual({
      kind: "release",
      mission: ship.key,
      host: DESK,
      missionId: ship.mission.missionId,
      refusal: null,
    });
    expect(
      drop("list", { source: { host: DESK, missionId: other.mission.missionId } })?.refusal,
    ).toBe("This thread moved to another mission.");
  });

  it("adds a thread, even one with no messages, and refuses an add on a machine this client may not change", () => {
    expect(drop(other.key)).toEqual({
      kind: "add",
      mission: other.key,
      host: DESK,
      missionId: other.mission.missionId,
      refusal: null,
    });
    const empty = { ...thread(DESK, "docs"), latestUserMessageAt: null, visibleItemCount: 0 };
    expect(drop(other.key, { threads: [empty] })?.refusal).toBeNull();
    expect(drop(other.key, { canChangeOn: () => false })?.refusal).toBe("Not allowed here");
  });
});
