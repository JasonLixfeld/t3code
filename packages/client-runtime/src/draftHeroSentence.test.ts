import { describe, expect, it } from "vite-plus/test";

import { MISSION_SLOT, PROJECT_SLOT, splitDraftHeroSentence } from "./draftHeroSentence.ts";

describe("splitDraftHeroSentence", () => {
  it("splits at the project and the mission", () => {
    expect(splitDraftHeroSentence(`Build in ${PROJECT_SLOT}, in ${MISSION_SLOT}?`)).toEqual({
      beforeProject: "Build in ",
      beforeMission: ", in ",
      afterMission: "?",
    });
  });

  it("keeps a sentence without the project whole before the mission", () => {
    expect(splitDraftHeroSentence(`Work in ${MISSION_SLOT}?`)).toEqual({
      beforeProject: "",
      beforeMission: "Work in ",
      afterMission: "?",
    });
  });

  it.each([
    ["the mission before the project", `${MISSION_SLOT} in ${PROJECT_SLOT}?`, " in ?"],
    ["a placeholder twice", `${PROJECT_SLOT} or ${PROJECT_SLOT}?`, " or ?"],
  ])("shows no marker for %s", (_, sentence, words) => {
    expect(splitDraftHeroSentence(sentence)).toEqual({
      beforeProject: words,
      beforeMission: "",
      afterMission: "",
    });
  });
});
