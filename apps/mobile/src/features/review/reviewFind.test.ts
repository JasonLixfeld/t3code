import { describe, expect, it } from "vite-plus/test";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import {
  findInReviewRows,
  REVIEW_FIND_HIGHLIGHT_LIMIT,
  REVIEW_FIND_LINES_PER_FILE,
  REVIEW_FIND_MAX_MATCHES,
  reviewFindHighlightsJson,
} from "./reviewFind";

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

    expect(result.matches.map((match) => [match.rowId, match.start, match.end])).toEqual([
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
    expect(result.files[0]!.lines[0]).toMatchObject({
      change: "add",
      lineNumber: 1,
      matchCount: 3,
    });
    expect(result.files[1]!.lines[0]).toMatchObject({ change: "delete", lineNumber: 7 });
  });

  it("does not match the note of a cut line", () => {
    const rows = [line("a", 0, "short code… 400 more characters", { noteStart: 10 })];

    expect(findInReviewRows(rows, "more").matches).toEqual([]);
    expect(findInReviewRows(rows, "code").matches).toHaveLength(1);
  });

  it("reports UTF-16 offsets after astral characters and length-changing case folds", () => {
    const rows = [line("a", 0, "😀 İx Name")];

    const result = findInReviewRows(rows, "name");

    expect(result.matches[0]).toMatchObject({ start: 6, end: 10 });
    expect("😀 İx Name".slice(6, 10)).toBe("Name");
  });

  it("caps preview lines per file but keeps exact counts", () => {
    const rows = Array.from({ length: REVIEW_FIND_LINES_PER_FILE + 5 }, (_, index) =>
      line("a", index, "match"),
    );

    const [file] = findInReviewRows(rows, "match").files;

    expect(file!.lines).toHaveLength(REVIEW_FIND_LINES_PER_FILE);
    expect(file!.lineCount).toBe(REVIEW_FIND_LINES_PER_FILE + 5);
    expect(file!.matchCount).toBe(REVIEW_FIND_LINES_PER_FILE + 5);
  });

  it("stops at the match limit and says so", () => {
    const rows = [line("a", 0, "x".repeat(REVIEW_FIND_MAX_MATCHES + 3))];

    const result = findInReviewRows(rows, "x");

    expect(result.matches).toHaveLength(REVIEW_FIND_MAX_MATCHES);
    expect(result.limited).toBe(true);
  });

  it("trims a long line preview around its first match and shifts the highlight", () => {
    const content = `${"a".repeat(100)}needle${"b".repeat(300)}`;

    const [preview] = findInReviewRows([line("a", 0, content)], "needle").files[0]!.lines;

    expect(preview!.text.startsWith("…")).toBe(true);
    expect(preview!.text.endsWith("…")).toBe(true);
    const range = preview!.ranges[0]!;
    expect(preview!.text.slice(range.start, range.end)).toBe("needle");
  });
});

describe("reviewFindHighlightsJson", () => {
  it("sends the active match and nearby ranges grouped by row", () => {
    const { matches } = findInReviewRows([line("a", 0, "ab ab"), line("a", 1, "ab")], "ab");

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
  });

  it("clears highlights without an active match", () => {
    const { matches } = findInReviewRows([line("a", 0, "ab")], "ab");

    expect(reviewFindHighlightsJson(matches, null)).toBe("");
  });

  it("bounds the ranges sent to native to a window around the active match", () => {
    const rows = Array.from({ length: REVIEW_FIND_HIGHLIGHT_LIMIT * 3 }, (_, index) =>
      line("a", index, "hit"),
    );
    const { matches } = findInReviewRows(rows, "hit");
    const activeIndex = REVIEW_FIND_HIGHLIGHT_LIMIT * 2;

    const payload = JSON.parse(reviewFindHighlightsJson(matches, activeIndex)) as {
      ranges: Record<string, unknown>;
    };

    expect(Object.keys(payload.ranges)).toHaveLength(REVIEW_FIND_HIGHLIGHT_LIMIT);
    expect(payload.ranges[matches[activeIndex]!.rowId]).toBeDefined();
  });
});
