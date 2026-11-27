import type { MissionHost } from "@t3tools/client-runtime/missions";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import {
  chosenDraftMissionOption,
  draftHeroTokens,
  draftMissionChoice,
} from "./draftMission.logic";

const DESK = EnvironmentId.make("env-desk");
const LAPTOP = EnvironmentId.make("env-laptop");
const mission = (missionId: string, name: string) => ({
  missionId,
  name,
  createdAt: "2026-11-23T00:00:00.000Z",
  members: [],
});
const hosts: ReadonlyArray<MissionHost> = [
  {
    environmentId: DESK,
    snapshot: { missions: [mission("m1", "Ship v2")], claims: [], links: [] },
  },
  {
    environmentId: LAPTOP,
    snapshot: { missions: [mission("m2", "Docs")], claims: [], links: [] },
  },
];
const choice = (
  intent: Parameters<typeof draftMissionChoice>[0]["intent"],
  input: { startMachines?: ReadonlySet<EnvironmentId>; enabled?: boolean } = {},
) =>
  draftMissionChoice(
    {
      enabled: input.enabled ?? true,
      hosts,
      startMachines: input.startMachines ?? new Set([DESK]),
      intent,
      environmentId: DESK,
    },
    m,
  );

describe("draftHeroTokens", () => {
  it.each([
    [
      { scratch: false, mission: "member" },
      "What should we build in [project], in mission [mission]?",
    ],
    [{ scratch: true, mission: "lead" }, "What should we work on as the new lead for [mission]?"],
  ] as const)("splits %o into whole words, keeping the glue on its choice", (input, sentence) => {
    const tokens = draftHeroTokens(input, m);
    expect(
      tokens
        .map((token) => (token.kind === "text" ? token.text : `[${token.kind}]${token.glue}`))
        .join(""),
    ).toBe(sentence);
    expect(tokens.every((token) => token.kind !== "text" || /^\S+ $/.test(token.text))).toBe(true);
    expect(new Set(tokens.map((token) => token.key)).size).toBe(tokens.length);
  });
});

describe("draftMissionChoice", () => {
  it("offers the machine's missions and a new one, with Add to a mission until one is chosen", () => {
    const none = choice(undefined);
    expect(none).toMatchObject({ kind: "none", label: "Add to a mission", selected: "none" });
    expect(none?.options.map((option) => [option.label, option.disabled])).toEqual([
      ["None", false],
      ["Ship v2", false],
      ["New mission (this thread leads)", false],
    ]);
    const joined = choice({ kind: "member", host: DESK, missionId: "m1", name: "Ship v2" });
    expect(joined).toMatchObject({ kind: "member", word: "Ship v2", selected: "env-desk:m1" });
  });

  it("keeps a mission from another machine that the draft joins, and marks one that is gone", () => {
    const linked = choice({ kind: "member", host: LAPTOP, missionId: "m2", name: "Docs" });
    expect(linked?.options.at(-2)).toMatchObject({ id: "env-laptop:m2", label: "Docs" });
    const gone = choice({ kind: "member", host: LAPTOP, missionId: "m9", name: "Old" });
    expect(gone).toMatchObject({ word: "Unavailable mission" });
    expect(gone?.options.at(-2)).toMatchObject({ disabled: true, intent: null });
  });

  it("only offers to send a lead or a new mission's draft as a plain thread", () => {
    const lead = choice({
      kind: "lead",
      host: DESK,
      missionId: "m1",
      name: "Ship v2",
      expectedLead: ThreadId.make("gone"),
    });
    expect(lead).toMatchObject({ kind: "lead", word: "Ship v2", fixed: true });
    expect(lead?.options).toEqual([
      { id: "none", label: "Send as a plain thread", disabled: false, intent: null },
    ]);
    expect(choice({ kind: "new" })).toMatchObject({ word: "a new mission", label: "New mission" });
  });

  const member = { kind: "member", host: DESK, missionId: "m1", name: "Ship v2" } as const;
  it.each([
    ["sends a new mission draft as a plain thread", { kind: "new" }, "none", { intent: null }],
    [
      "sends a lead draft as a plain thread",
      {
        kind: "lead",
        host: DESK,
        missionId: "m1",
        name: "Ship v2",
        expectedLead: ThreadId.make("gone"),
      },
      "none",
      { intent: null },
    ],
    ["takes a member draft out of its mission", member, "none", { intent: null }],
    ["ignores the option a member draft already has", member, "env-desk:m1", undefined],
  ] as const)("%s", (_name, intent, id, expected) => {
    expect(chosenDraftMissionOption(choice(intent), id)).toEqual(
      expected && expect.objectContaining(expected),
    );
  });

  it("hides the choice when Missions are off, or the machine may not start one and none is marked", () => {
    expect(choice(undefined, { enabled: false })).toBeNull();
    expect(choice(undefined, { startMachines: new Set() })).toBeNull();
    const marked = choice(
      { kind: "member", host: DESK, missionId: "m1", name: "Ship v2" },
      { startMachines: new Set() },
    );
    expect(marked?.options.map((option) => option.disabled)).toEqual([false, true, true]);
  });
});
