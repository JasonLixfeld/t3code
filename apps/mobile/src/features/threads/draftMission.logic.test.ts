import type { MissionHost } from "@t3tools/client-runtime/missions";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import { clearMissionDraft, markMissionDraft, missionDraftOf } from "../../state/mission-drafts";
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
  it("splits the sentence into whole words and keeps the comma after the project on its line", () => {
    expect(draftHeroTokens({ scratch: false, mission: "member" }, m)).toMatchObject([
      { kind: "text", text: "What " },
      { kind: "text", text: "should " },
      { kind: "text", text: "we " },
      { kind: "text", text: "build " },
      { kind: "text", text: "in " },
      { kind: "project", glue: ", " },
      { kind: "text", text: "in " },
      { kind: "text", text: "mission " },
      { kind: "mission", glue: "?" },
    ]);
  });

  it("leaves the project out of a No project draft's sentence", () => {
    const tokens = draftHeroTokens({ scratch: true, mission: "lead" }, m);
    expect(tokens.some((token) => token.kind === "project")).toBe(false);
    expect(
      tokens.map((token) => (token.kind === "text" ? token.text : `[${token.kind}]`)).join(""),
    ).toBe("What should we work on as the new lead for [mission]");
    expect(tokens.at(-1)).toMatchObject({ kind: "mission", glue: "?" });
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

  it("clears a new mission or lead mark when the draft is sent as a plain thread", () => {
    const intents = [
      { kind: "new" as const },
      {
        kind: "lead" as const,
        host: DESK,
        missionId: "m1",
        name: "Ship v2",
        expectedLead: ThreadId.make("gone"),
      },
    ];
    for (const intent of intents) {
      const target = { requestId: `request-${intent.kind}` };
      markMissionDraft(target, intent, () => "m-new");
      const option = chosenDraftMissionOption(choice(missionDraftOf(target)?.intent), "none");
      expect(option).toMatchObject({ label: "Send as a plain thread", intent: null });
      if (option?.intent === null) clearMissionDraft(target);
      expect(missionDraftOf(target)).toBeUndefined();
    }
  });

  it("ignores the option a member draft already has", () => {
    const joined = choice({ kind: "member", host: DESK, missionId: "m1", name: "Ship v2" });
    expect(chosenDraftMissionOption(joined, "env-desk:m1")).toBeUndefined();
    expect(chosenDraftMissionOption(joined, "none")).toMatchObject({ intent: null });
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
