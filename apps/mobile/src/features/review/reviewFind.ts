import type { SearchRange } from "@t3tools/shared/paletteSearch";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";

export const REVIEW_FIND_LINES_PER_FILE = 20;
export const REVIEW_FIND_MAX_LINES = 500;
export const REVIEW_FIND_HIGHLIGHT_LIMIT = 1_000;
const SNIPPET_LENGTH = 200;
const LEADING_CONTEXT = 16;
const HIGHLIGHTS_PER_LINE = 10;

export interface ReviewFindMatch {
  readonly rowId: string;
  readonly fileId: string;
  readonly start: number;
  readonly end: number;
}

export interface ReviewFindLine {
  readonly rowId: string;
  readonly change: "context" | "add" | "delete";
  readonly lineNumber: number | null;
  readonly text: string;
  readonly ranges: ReadonlyArray<SearchRange>;
  readonly firstMatchIndex: number;
  readonly matchCount: number;
}

export interface ReviewFindFile {
  readonly fileId: string;
  readonly matchCount: number;
  readonly firstMatchIndex: number;
  readonly lineCount: number;
  readonly previewLines: ReadonlyArray<ReviewFindLine>;
}

export interface ReviewFindResult {
  readonly matches: ReadonlyArray<ReviewFindMatch>;
  readonly files: ReadonlyArray<ReviewFindFile>;
}

export const EMPTY_REVIEW_FIND_RESULT: ReviewFindResult = {
  matches: [],
  files: [],
};

// Pierre's web find: an escaped literal with the "gi" flags, so both surfaces fold case alike.
function literalCaseInsensitivePattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

function presentLine(
  row: NativeReviewDiffRow,
  code: string,
  matches: ReadonlyArray<ReviewFindMatch>,
  firstMatchIndex: number,
): ReviewFindLine {
  const first = matches[0]!;
  const indent = code.length - code.trimStart().length;
  const start = Math.min(first.start, Math.max(indent, first.start - LEADING_CONTEXT));
  const end = Math.min(code.length, start + SNIPPET_LENGTH);
  const prefix = start > indent ? "…" : "";
  const suffix = end < code.length ? "…" : "";
  const ranges: SearchRange[] = [];
  for (const match of matches) {
    if (ranges.length === HIGHLIGHTS_PER_LINE || match.start >= end) break;
    ranges.push({
      start: match.start - start + prefix.length,
      end: Math.min(match.end, end) - start + prefix.length,
    });
  }
  const change = row.change ?? "context";
  return {
    rowId: row.id,
    change,
    lineNumber:
      change === "delete"
        ? (row.oldLineNumber ?? null)
        : (row.newLineNumber ?? row.oldLineNumber ?? null),
    text: prefix + code.slice(start, end) + suffix,
    ranges,
    firstMatchIndex,
    matchCount: matches.length,
  };
}

export function findInReviewRows(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  query: string,
): ReviewFindResult {
  if (query.length === 0) return EMPTY_REVIEW_FIND_RESULT;
  const pattern = literalCaseInsensitivePattern(query);
  const matches: ReviewFindMatch[] = [];
  const files: Array<{
    fileId: string;
    matchCount: number;
    firstMatchIndex: number;
    lineCount: number;
    previewLines: ReviewFindLine[];
  }> = [];
  let shownLines = 0;
  for (const row of rows) {
    if (row.kind !== "line" || !row.content) continue;
    const code = row.noteStart === undefined ? row.content : row.content.slice(0, row.noteStart);
    const rowStart = matches.length;
    for (const found of code.matchAll(pattern)) {
      const start = found.index;
      matches.push({
        rowId: row.id,
        fileId: row.fileId ?? "",
        start,
        end: start + found[0].length,
      });
    }
    if (matches.length > rowStart) {
      const fileId = row.fileId ?? "";
      let file = files.at(-1);
      if (file?.fileId !== fileId) {
        file = { fileId, matchCount: 0, firstMatchIndex: rowStart, lineCount: 0, previewLines: [] };
        files.push(file);
      }
      file.matchCount += matches.length - rowStart;
      file.lineCount += 1;
      if (
        file.previewLines.length < REVIEW_FIND_LINES_PER_FILE &&
        shownLines < REVIEW_FIND_MAX_LINES
      ) {
        file.previewLines.push(presentLine(row, code, matches.slice(rowStart), rowStart));
        shownLines += 1;
      }
    }
  }
  return { matches, files };
}

export function resolveReviewFindActiveIndex(
  matches: ReadonlyArray<ReviewFindMatch>,
  active: { readonly rowId: string; readonly start: number } | null,
): number | null {
  if (matches.length === 0) return null;
  const index = active
    ? matches.findIndex((match) => match.rowId === active.rowId && match.start === active.start)
    : -1;
  return Math.max(0, index);
}

export function stepReviewFindIndex(index: number, direction: 1 | -1, count: number): number {
  return (index + direction + count) % count;
}

export function reviewFindHighlightsJson(
  matches: ReadonlyArray<ReviewFindMatch>,
  activeIndex: number | null,
): string {
  const active = activeIndex === null ? undefined : matches[activeIndex];
  if (activeIndex === null || active === undefined) return "";
  const first = Math.max(
    0,
    Math.min(
      activeIndex - REVIEW_FIND_HIGHLIGHT_LIMIT / 2,
      matches.length - REVIEW_FIND_HIGHLIGHT_LIMIT,
    ),
  );
  const ranges = new Map<string, Array<[number, number]>>();
  for (const match of matches.slice(first, first + REVIEW_FIND_HIGHLIGHT_LIMIT)) {
    const rowRanges = ranges.get(match.rowId);
    if (rowRanges) rowRanges.push([match.start, match.end]);
    else ranges.set(match.rowId, [[match.start, match.end]]);
  }
  return JSON.stringify({
    ranges: Object.fromEntries(ranges),
    active: { rowId: active.rowId, start: active.start, end: active.end },
  });
}
