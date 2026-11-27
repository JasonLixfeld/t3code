import { describe, expect, it } from "vite-plus/test";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import {
  EMPTY_REVIEW_FIND_RESULT,
  findInReviewRows,
  REVIEW_FIND_HIGHLIGHT_LIMIT,
  REVIEW_FIND_LINES_PER_FILE,
  resolveReviewFindActiveIndex,
  reviewFindHighlightsJson,
  stepReviewFindIndex,
  type ReviewFindResult,
} from "./reviewFind";

function allMatches(result: ReviewFindResult) {
  return Array.from({ length: result.matchCount }, (_, index) => result.matchAt(index)!);
}

function line(
  fileId: string,
  index: number,
  content: string,
  extra: Partial<NativeReviewDiffRow> = {},
): NativeReviewDiffRow {
  return {
    kind: "line",
    id: `${fileId}:line:${index}`,
    fileId,
    content,
    change: "context",
    oldLineNumber: index + 1,
    newLineNumber: index + 1,
    ...extra,
  };
}

describe("findInReviewRows", () => {
  it("counts case-insensitive literal matches per file in render order", () => {
    const rows: NativeReviewDiffRow[] = [
      { kind: "file", id: "a:header", fileId: "a", filePath: "a.ts" },
      { kind: "hunk", id: "a:hunk:0", fileId: "a", text: "@@ -1 +1 @@ Foo" },
      line("a", 0, "const Foo = foo(FOO);", { change: "add", oldLineNumber: null }),
      line("a", 1, "nothing here"),
      { kind: "file", id: "b:header", fileId: "b", filePath: "b.ts" },
      line("b", 0, "removed foo", { change: "delete", oldLineNumber: 7, newLineNumber: null }),
    ];

    const result = findInReviewRows(rows, "foo");

    expect(allMatches(result).map((match) => [match.rowId, match.start, match.end])).toEqual([
      ["a:line:0", 6, 9],
      ["a:line:0", 12, 15],
      ["a:line:0", 16, 19],
      ["b:line:0", 8, 11],
    ]);
    expect(
      result.files.map((file) => [file.fileId, file.matchCount, file.firstMatchIndex]),
    ).toEqual([
      ["a", 3, 0],
      ["b", 1, 3],
    ]);
    expect(result.files[0]!.previewLines[0]).toMatchObject({
      change: "add",
      lineNumber: 1,
      matchCount: 3,
    });
    expect(result.files[1]!.previewLines[0]).toMatchObject({ change: "delete", lineNumber: 7 });
  });

  it("does not match the note of a cut line", () => {
    const rows = [line("a", 0, "short code… 400 more characters", { noteStart: 10 })];

    expect(findInReviewRows(rows, "more").matchCount).toBe(0);
    expect(findInReviewRows(rows, "code").matchCount).toBe(1);
  });

  it.each([
    [
      "reports UTF-16 offsets after astral characters and length-changing case folds",
      "😀 İx Name",
      "name",
      [[6, 10]],
    ],
    [
      "folds case like the web diff, including final sigma",
      "ΟΔΟΣ οδος",
      "Σ",
      [
        [3, 4],
        [8, 9],
      ],
    ],
    ["matches regular expression characters literally", "axb a.b (a|b)", "a.b", [[4, 7]]],
    ["matches a regular expression group literally", "axb a.b (a|b)", "(a|b)", [[8, 13]]],
  ])("%s", (_name, content, query, expected) => {
    expect(
      allMatches(findInReviewRows([line("a", 0, content)], query)).map((match) => [
        match.start,
        match.end,
      ]),
    ).toEqual(expected);
  });

  it("caps preview lines per file but keeps exact counts", () => {
    const rows = Array.from({ length: REVIEW_FIND_LINES_PER_FILE + 5 }, (_, index) =>
      line("a", index, "match"),
    );

    const [file] = findInReviewRows(rows, "match").files;

    expect(file!.previewLines).toHaveLength(REVIEW_FIND_LINES_PER_FILE);
    expect(file!.lineCount).toBe(REVIEW_FIND_LINES_PER_FILE + 5);
    expect(file!.matchCount).toBe(REVIEW_FIND_LINES_PER_FILE + 5);
  });

  it("counts every match and keeps files past ten thousand hits", () => {
    const rows = [line("a", 0, "x".repeat(12_000)), line("b", 0, "x x")];

    const result = findInReviewRows(rows, "x");

    expect(result.matchCount).toBe(12_002);
    expect(result.files.map((file) => [file.fileId, file.matchCount])).toEqual([
      ["a", 12_000],
      ["b", 2],
    ]);
  });

  it("trims a long line preview around its first match without splitting a surrogate pair", () => {
    const content = `${"b".repeat(50)}😀${"c".repeat(15)}needle${"d".repeat(176)}😀tail`;

    const [preview] = findInReviewRows([line("a", 0, content)], "needle").files[0]!.previewLines;

    expect(preview!.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(preview!.text.startsWith("…😀")).toBe(true);
    expect(preview!.text.endsWith("😀…")).toBe(true);
    const range = preview!.ranges[0]!;
    expect(preview!.text.slice(range.start, range.end)).toBe("needle");
  });
});

describe("reviewFindHighlightsJson", () => {
  it("sends the active match and nearby ranges grouped by row", () => {
    const matches = findInReviewRows([line("a", 0, "ab ab"), line("a", 1, "ab")], "ab");

    expect(JSON.parse(reviewFindHighlightsJson(matches, 1))).toEqual({
      ranges: {
        "a:line:0": [
          [0, 2],
          [3, 5],
        ],
        "a:line:1": [[0, 2]],
      },
      active: { rowId: "a:line:0", start: 3, end: 5 },
    });
    expect(reviewFindHighlightsJson(matches, null)).toBe("");
  });

  it("bounds the ranges sent to native to a window around the active match", () => {
    const rows = Array.from({ length: REVIEW_FIND_HIGHLIGHT_LIMIT * 3 }, (_, index) =>
      line("a", index, "hit"),
    );
    const matches = findInReviewRows(rows, "hit");
    const activeIndex = REVIEW_FIND_HIGHLIGHT_LIMIT * 2;

    const payload = JSON.parse(reviewFindHighlightsJson(matches, activeIndex)) as {
      ranges: Record<string, unknown>;
    };

    expect(Object.keys(payload.ranges)).toHaveLength(REVIEW_FIND_HIGHLIGHT_LIMIT);
    expect(payload.ranges[matches.matchAt(activeIndex)!.rowId]).toBeDefined();
  });
});

describe("find stepping", () => {
  it("wraps from the last match to the first and from the first to the last", () => {
    expect(stepReviewFindIndex(2, 1, 3)).toBe(0);
    expect(stepReviewFindIndex(0, -1, 3)).toBe(2);
    expect(stepReviewFindIndex(1, 1, 3)).toBe(2);
    expect(stepReviewFindIndex(0, 1, 1)).toBe(0);
  });

  it("keeps the active match by identity when rows load before it, even deep in a dense row", () => {
    const before = findInReviewRows([line("b", 0, "x x")], "x");
    const after = findInReviewRows([line("a", 0, "x".repeat(12_000)), line("b", 0, "x x")], "x");
    const active = { rowId: before.matchAt(1)!.rowId, start: before.matchAt(1)!.start };

    expect(resolveReviewFindActiveIndex(before, active)).toBe(1);
    expect(resolveReviewFindActiveIndex(after, active)).toBe(12_001);
    expect(resolveReviewFindActiveIndex(after, { rowId: "a:line:0", start: 9_000 })).toBe(9_000);
  });

  it("starts at the first match, and falls back to it when the active one is gone", () => {
    const matches = findInReviewRows([line("a", 0, "hit hit")], "hit");

    expect(resolveReviewFindActiveIndex(matches, null)).toBe(0);
    expect(resolveReviewFindActiveIndex(matches, { rowId: "gone", start: 0 })).toBe(0);
    expect(resolveReviewFindActiveIndex(EMPTY_REVIEW_FIND_RESULT, null)).toBeNull();
  });
});
