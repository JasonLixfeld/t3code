import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { MISSION_PROMPT_MAX_LENGTH, MissionSetPromptInput, missionTag } from "./mission.ts";
import { ThreadTag } from "./threadTags.ts";

const isTag = Schema.is(ThreadTag);

it.each([
  ["an emoji across the limit", "a".repeat(42) + "😀"],
  ["an emoji just inside the limit", "a".repeat(41) + "😀"],
  ["a flag of two code points", "a".repeat(41) + "🇨🇦"],
  ["only emoji", "😀".repeat(40)],
])("cuts %s into a well-formed mission tag the tag schema accepts", (_name, name) => {
  const tag = missionTag("0123456789ab", name);
  assert.isTrue(tag.isWellFormed(), tag);
  assert.isAtMost(tag.length, 64);
  assert.isTrue(isTag(tag));
  assert.isTrue(`mission:0123456789ab:${name}`.startsWith(tag));
});

it("a mission prompt longer than the bound is refused before it is saved", () => {
  const accepts = Schema.is(MissionSetPromptInput);
  const prompt = (length: number) => ({ missionId: "0123456789ab", prompt: "x".repeat(length) });
  assert.isTrue(accepts(prompt(MISSION_PROMPT_MAX_LENGTH)));
  assert.isFalse(accepts(prompt(MISSION_PROMPT_MAX_LENGTH + 1)));
});
