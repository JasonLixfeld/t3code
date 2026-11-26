// @effect-diagnostics nodeBuiltinImport:off - a plain test that reads the translation catalogs once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { MISSION_SLOT, PROJECT_SLOT, splitDraftHeroSentence } from "./draftHeroSentence";

const HEADLINES = [
  "What should we build in {project}?",
  "What should we build in {project}, in mission {mission}?",
  "What should we build in {project}, in {mission}?",
  "What should we build in {project}, as the new lead for {mission}?",
  "{project} to start",
  "What should we work on in mission {mission}?",
  "What should we work on in {mission}?",
  "What should we work on as the new lead for {mission}?",
];

const catalogDirectory = NodePath.join(import.meta.dirname, "../../i18n/translations");
const catalogs = NodeFS.readdirSync(catalogDirectory)
  .filter((file) => file.endsWith(".json"))
  .map(
    (file) =>
      [
        file,
        JSON.parse(NodeFS.readFileSync(NodePath.join(catalogDirectory, file), "utf8")) as Record<
          string,
          unknown
        >,
      ] as const,
  );
const english = Object.fromEntries(catalogs)["en.json"]!;
const count = (text: string, placeholder: string) => text.split(placeholder).length - 1;

describe("draft headline translations", () => {
  it.each(HEADLINES)("every catalog keeps the placeholders of %j once, in order", (source) => {
    const key = Object.keys(english).find((candidate) => english[candidate] === source);
    expect(key).toBeDefined();
    for (const [file, catalog] of catalogs) {
      const text = catalog[key!];
      expect(typeof text, file).toBe("string");
      const translated = text as string;
      for (const placeholder of ["{project}", "{mission}"]) {
        expect(count(translated, placeholder), `${file}: ${translated}`).toBe(
          count(source, placeholder),
        );
      }
      if (source.includes("{project}") && source.includes("{mission}")) {
        expect(
          translated.indexOf("{project}") < translated.indexOf("{mission}"),
          `${file}: ${translated}`,
        ).toBe(true);
      }
    }
  });
});

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
