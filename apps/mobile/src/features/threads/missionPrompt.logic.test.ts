import { describe, expect, it } from "vite-plus/test";

import { missionPromptForm } from "./missionPrompt.logic";

const form = (input: Partial<Parameters<typeof missionPromptForm>[0]>) =>
  missionPromptForm({
    promptsOmitted: false,
    listed: "Ship it",
    read: null,
    draft: null,
    canSave: true,
    ...input,
  });

describe("missionPromptForm", () => {
  it("edits the listed prompt, and saves only a trimmed change", () => {
    expect(form({})).toEqual({ value: "Ship it", next: undefined, editable: true, changed: false });
    expect(form({ draft: " Ship it " }).changed).toBe(false);
    expect(form({ draft: "Ship it today " })).toMatchObject({
      next: "Ship it today",
      changed: true,
    });
  });

  it("waits for missions.getPrompt when the list leaves prompts out", () => {
    expect(form({ promptsOmitted: true, draft: "New" })).toMatchObject({
      editable: false,
      changed: false,
    });
    expect(form({ promptsOmitted: true, read: "Read prompt" })).toMatchObject({
      value: "Read prompt",
      editable: true,
    });
  });

  it("shows the prompt but never saves it without the right to set it", () => {
    expect(form({ canSave: false, draft: "Changed" })).toMatchObject({
      value: "Changed",
      editable: false,
      changed: false,
    });
  });
});
