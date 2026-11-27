import { describe, expect, it } from "vite-plus/test";

import { missionPromptForm } from "./missionPrompt.logic";

const form = (input: Partial<Parameters<typeof missionPromptForm>[0]>) =>
  missionPromptForm({
    promptsOmitted: false,
    listed: "Ship it",
    fetchedPrompt: null,
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

  it.each([
    [
      "waits for missions.getPrompt when the list leaves prompts out",
      { promptsOmitted: true, draft: "New" },
      { editable: false, changed: false },
    ],
    [
      "edits the prompt missions.getPrompt read",
      { promptsOmitted: true, fetchedPrompt: "Read prompt" },
      { value: "Read prompt", editable: true },
    ],
    [
      "shows the prompt but never saves it without the right to set it",
      { canSave: false, draft: "Changed" },
      { value: "Changed", editable: false, changed: false },
    ],
  ])("%s", (_name, input, expected) => {
    expect(form(input)).toMatchObject(expected);
  });
});
