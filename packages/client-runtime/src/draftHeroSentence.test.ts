import { describe, expect, it } from "vite-plus/test";

import { MISSION_SLOT, PROJECT_SLOT, splitDraftHeroSentence } from "./draftHeroSentence.ts";

describe("splitDraftHeroSentence", () => {
  it.each([
    [
      "at the project and the mission",
      `Build in ${PROJECT_SLOT}, in ${MISSION_SLOT}?`,
      { beforeProject: "Build in ", beforeMission: ", in ", afterMission: "?" },
    ],
    [
      "a sentence without the project before the mission",
      `Work in ${MISSION_SLOT}?`,
      { beforeProject: "", beforeMission: "Work in ", afterMission: "?" },
    ],
  ])("splits %s", (_, sentence, parts) => {
    expect(splitDraftHeroSentence(sentence)).toEqual(parts);
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
