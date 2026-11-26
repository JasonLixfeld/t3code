import { parsePatchFiles } from "@pierre/diffs";
import { expect, it } from "vite-plus/test";

import {
  DIFF_FIND_LINES_PER_FILE,
  type DiffFindMatch,
  groupDiffFindMatches,
} from "./diffFind.logic";

it("caps the lines listed per file and keeps a long line's match in view", () => {
  const lineCount = DIFF_FIND_LINES_PER_FILE + 5;
  const added = Array.from({ length: lineCount }, (_, index) =>
    index === 0 ? `+${" ".repeat(4)}${"x".repeat(60)}hit` : `+hit ${index}`,
  );
  const [fileDiff] = parsePatchFiles(
    `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,${lineCount} @@\n${added.join("\n")}\n`,
  ).flatMap((patch) => patch.files);
  const matches: DiffFindMatch[] = added.map((line, lineIndex) => {
    const start = line.indexOf("hit") - 1;
    return {
      itemId: "a",
      itemType: "diff",
      side: "additions",
      lineNumber: lineIndex + 1,
      lineIndex,
      startCharacter: start,
      endCharacter: start + 3,
    };
  });
  const [file] = groupDiffFindMatches(matches, () => fileDiff);
  expect(file?.matchCount).toBe(lineCount);
  expect(file?.lines).toHaveLength(DIFF_FIND_LINES_PER_FILE);
  expect(file?.hiddenLineCount).toBe(5);
  const first = file!.lines[0]!;
  expect(first.kind).toBe("addition");
  expect(first.text.startsWith("…")).toBe(true);
  const range = first.ranges[0]!;
  expect(first.text.slice(range.start, range.end)).toBe("hit");
});
