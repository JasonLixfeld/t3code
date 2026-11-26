import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import { expect, it } from "vite-plus/test";

import {
  DIFF_FIND_HIGHLIGHTS_PER_LINE,
  DIFF_FIND_LINES_PER_FILE,
  DIFF_FIND_MAX_LINES,
  DIFF_FIND_SNIPPET_LENGTH,
  type DiffFindMatch,
  groupDiffFindMatches,
} from "./diffFind.logic";

function addedFile(lines: ReadonlyArray<string>): FileDiffMetadata {
  const patch = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  return parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0]!;
}

function matchesOf(itemId: string, lines: ReadonlyArray<string>, term: string): DiffFindMatch[] {
  return lines.flatMap((line, lineIndex) =>
    [...line.matchAll(new RegExp(term, "g"))].map((found) => ({
      itemId,
      itemType: "diff" as const,
      side: "additions" as const,
      lineNumber: lineIndex + 1,
      lineIndex,
      startCharacter: found.index,
      endCharacter: found.index + term.length,
    })),
  );
}

it("caps the lines listed per file and bounds a long line's snippet and highlights", () => {
  const lines = Array.from({ length: DIFF_FIND_LINES_PER_FILE + 5 }, (_, index) =>
    index === 0 ? `    ${"x".repeat(60)}${"hit ".repeat(100)}` : `hit ${index}`,
  );
  const fileDiff = addedFile(lines);
  const matches = matchesOf("a", lines, "hit");
  const [file] = groupDiffFindMatches(matches, () => fileDiff);
  expect(file?.matchCount).toBe(matches.length);
  expect(file?.lines).toHaveLength(DIFF_FIND_LINES_PER_FILE);
  expect(file?.hiddenLineCount).toBe(5);
  expect(file?.firstHiddenMatchIndex).toBe(matches.length - 5);
  const first = file!.lines[0]!;
  expect(first.kind).toBe("addition");
  expect(first.text.length).toBeLessThanOrEqual(DIFF_FIND_SNIPPET_LENGTH + 2);
  expect(first.text.startsWith("…") && first.text.endsWith("…")).toBe(true);
  expect(first.ranges).toHaveLength(DIFF_FIND_HIGHLIGHTS_PER_LINE);
  for (const range of first.ranges) expect(first.text.slice(range.start, range.end)).toBe("hit");
});

it("keeps every file's count exact and reachable after the total line cap", () => {
  const lines = Array.from({ length: DIFF_FIND_LINES_PER_FILE }, (_, index) => `hit ${index}`);
  const fileDiff = addedFile(lines);
  const fileCount = DIFF_FIND_MAX_LINES / DIFF_FIND_LINES_PER_FILE + 2;
  const matches = Array.from({ length: fileCount }, (_, index) =>
    matchesOf(`file-${index}`, lines, "hit"),
  ).flat();
  const files = groupDiffFindMatches(matches, () => fileDiff);
  expect(files.map((file) => file.matchCount)).toEqual(
    Array.from({ length: fileCount }, () => DIFF_FIND_LINES_PER_FILE),
  );
  expect(files.reduce((shown, file) => shown + file.lines.length, 0)).toBe(DIFF_FIND_MAX_LINES);
  const cut = files.at(-1)!;
  expect(cut.lines).toHaveLength(0);
  expect(cut.hiddenLineCount).toBe(DIFF_FIND_LINES_PER_FILE);
  expect(matches[cut.firstHiddenMatchIndex!]?.itemId).toBe(cut.itemId);
});
