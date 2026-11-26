import type { SearchRange } from "@t3tools/shared/paletteSearch";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";

export const REVIEW_FIND_MAX_MATCHES = 10_000;
export const REVIEW_FIND_LINES_PER_FILE = 20;
export const REVIEW_FIND_MAX_LINES = 500;
export const REVIEW_FIND_HIGHLIGHT_LIMIT = 1_000;
const SNIPPET_LENGTH = 200;
const LEADING_CONTEXT = 16;
const HIGHLIGHTS_PER_LINE = 10;

export interface ReviewFindMatch {
  readonly rowId: string;
  readonly fileId: string;
  /** UTF-16 offsets into the row's content. */
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
  /** Every matching line, including those past `lines`. */
  readonly lineCount: number;
  readonly lines: ReadonlyArray<ReviewFindLine>;
}

export interface ReviewFindResult {
  readonly matches: ReadonlyArray<ReviewFindMatch>;
  readonly files: ReadonlyArray<ReviewFindFile>;
  /** Matching stopped at `REVIEW_FIND_MAX_MATCHES`. */
  readonly limited: boolean;
}

export const EMPTY_REVIEW_FIND_RESULT: ReviewFindResult = {
  matches: [],
  files: [],
  limited: false,
};

// Folds one UTF-16 unit at a time so match offsets index the original text.
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return text.replace(/[\s\S]/g, (unit) => {
    const folded = unit.toLowerCase();
    return folded.length === 1 ? folded : unit;
  });
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

/** Case-insensitive literal matches in the code of the loaded diff rows, in render order. */
export function findInReviewRows(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  query: string,
): ReviewFindResult {
  if (query.length === 0) return EMPTY_REVIEW_FIND_RESULT;
  const needle = foldCase(query);
  const matches: ReviewFindMatch[] = [];
  const files: Array<{
    fileId: string;
    matchCount: number;
    firstMatchIndex: number;
    lineCount: number;
    lines: ReviewFindLine[];
  }> = [];
  let shownLines = 0;
  let limited = false;
  for (const row of rows) {
    if (row.kind !== "line" || !row.content) continue;
    // A cut line's note is not code.
    const code = row.noteStart === undefined ? row.content : row.content.slice(0, row.noteStart);
    const haystack = foldCase(code);
    const rowStart = matches.length;
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      if (matches.length === REVIEW_FIND_MAX_MATCHES) {
        limited = true;
        break;
      }
      matches.push({ rowId: row.id, fileId: row.fileId ?? "", start: at, end: at + needle.length });
    }
    if (matches.length > rowStart) {
      const fileId = row.fileId ?? "";
      let file = files.at(-1);
      if (file?.fileId !== fileId) {
        file = { fileId, matchCount: 0, firstMatchIndex: rowStart, lineCount: 0, lines: [] };
        files.push(file);
      }
      file.matchCount += matches.length - rowStart;
      file.lineCount += 1;
      if (file.lines.length < REVIEW_FIND_LINES_PER_FILE && shownLines < REVIEW_FIND_MAX_LINES) {
        file.lines.push(presentLine(row, code, matches.slice(rowStart), rowStart));
        shownLines += 1;
      }
    }
    if (limited) break;
  }
  return { matches, files, limited };
}

/** Sparse ranges near the active match; the native surface paints only rows on screen. */
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
