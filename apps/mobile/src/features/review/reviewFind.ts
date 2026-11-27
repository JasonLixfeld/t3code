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

/** Occurrences sit in parallel typed arrays, so a dense search keeps exact counts cheaply. */
export class ReviewFindResult {
  readonly matchCount: number;
  readonly files: ReadonlyArray<ReviewFindFile>;
  private readonly rowIds: ReadonlyArray<string>;
  private readonly rowFileIds: ReadonlyArray<string>;
  private readonly rowFirstMatch: ReadonlyArray<number>;
  private readonly rowById: ReadonlyMap<string, number>;
  private readonly matchRows: Int32Array;
  private readonly matchStarts: Int32Array;
  private readonly matchEnds: Int32Array;

  constructor(input: {
    readonly matchCount: number;
    readonly files: ReadonlyArray<ReviewFindFile>;
    readonly rowIds: ReadonlyArray<string>;
    readonly rowFileIds: ReadonlyArray<string>;
    readonly rowFirstMatch: ReadonlyArray<number>;
    readonly matchRows: Int32Array;
    readonly matchStarts: Int32Array;
    readonly matchEnds: Int32Array;
  }) {
    this.matchCount = input.matchCount;
    this.files = input.files;
    this.rowIds = input.rowIds;
    this.rowFileIds = input.rowFileIds;
    this.rowFirstMatch = input.rowFirstMatch;
    this.rowById = new Map(input.rowIds.map((rowId, index) => [rowId, index]));
    this.matchRows = input.matchRows;
    this.matchStarts = input.matchStarts;
    this.matchEnds = input.matchEnds;
  }

  matchAt(index: number): ReviewFindMatch | undefined {
    if (index < 0 || index >= this.matchCount) return undefined;
    const row = this.matchRows[index]!;
    return {
      rowId: this.rowIds[row]!,
      fileId: this.rowFileIds[row]!,
      start: this.matchStarts[index]!,
      end: this.matchEnds[index]!,
    };
  }

  indexOf(rowId: string, start: number): number {
    const row = this.rowById.get(rowId);
    if (row === undefined) return -1;
    let low = this.rowFirstMatch[row]!;
    let high = (this.rowFirstMatch[row + 1] ?? this.matchCount) - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const middleStart = this.matchStarts[middle]!;
      if (middleStart === start) return middle;
      if (middleStart < start) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
}

export const EMPTY_REVIEW_FIND_RESULT = new ReviewFindResult({
  matchCount: 0,
  files: [],
  rowIds: [],
  rowFileIds: [],
  rowFirstMatch: [],
  matchRows: new Int32Array(0),
  matchStarts: new Int32Array(0),
  matchEnds: new Int32Array(0),
});

// Match the default case folding in @pierre/diffs, which omits the `u` flag.
function literalCaseInsensitivePattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

function isLowSurrogate(code: string, index: number): boolean {
  const unit = code.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function presentLine(
  row: NativeReviewDiffRow,
  code: string,
  starts: ReadonlyArray<number>,
  ends: ReadonlyArray<number>,
  firstMatchIndex: number,
): ReviewFindLine {
  const firstStart = starts[0]!;
  const indent = code.length - code.trimStart().length;
  let start = Math.min(firstStart, Math.max(indent, firstStart - LEADING_CONTEXT));
  if (start > 0 && isLowSurrogate(code, start)) start -= 1;
  let end = Math.min(code.length, start + SNIPPET_LENGTH);
  if (end < code.length && isLowSurrogate(code, end)) end += 1;
  const prefix = start > indent ? "…" : "";
  const suffix = end < code.length ? "…" : "";
  const ranges: SearchRange[] = [];
  for (let index = 0; index < starts.length; index++) {
    if (ranges.length === HIGHLIGHTS_PER_LINE || starts[index]! >= end) break;
    ranges.push({
      start: starts[index]! - start + prefix.length,
      end: Math.min(ends[index]!, end) - start + prefix.length,
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
    matchCount: starts.length,
  };
}

function grow(array: Int32Array, size: number): Int32Array {
  if (size <= array.length) return array;
  const next = new Int32Array(Math.max(size, array.length * 2));
  next.set(array);
  return next;
}

export function findInReviewRows(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  query: string,
): ReviewFindResult {
  if (query.length === 0) return EMPTY_REVIEW_FIND_RESULT;
  const pattern = literalCaseInsensitivePattern(query);
  let matchCount = 0;
  let matchRows: Int32Array = new Int32Array(64);
  let matchStarts: Int32Array = new Int32Array(64);
  let matchEnds: Int32Array = new Int32Array(64);
  const rowIds: string[] = [];
  const rowFileIds: string[] = [];
  const rowFirstMatch: number[] = [];
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
    const starts: number[] = [];
    const ends: number[] = [];
    for (const found of code.matchAll(pattern)) {
      starts.push(found.index);
      ends.push(found.index + found[0].length);
    }
    if (starts.length === 0) continue;
    const rowStart = matchCount;
    const rowIndex = rowIds.length;
    const fileId = row.fileId ?? "";
    rowIds.push(row.id);
    rowFileIds.push(fileId);
    rowFirstMatch.push(rowStart);
    matchCount += starts.length;
    matchRows = grow(matchRows, matchCount);
    matchStarts = grow(matchStarts, matchCount);
    matchEnds = grow(matchEnds, matchCount);
    matchRows.fill(rowIndex, rowStart, matchCount);
    matchStarts.set(starts, rowStart);
    matchEnds.set(ends, rowStart);
    let file = files.at(-1);
    if (file?.fileId !== fileId) {
      file = { fileId, matchCount: 0, firstMatchIndex: rowStart, lineCount: 0, previewLines: [] };
      files.push(file);
    }
    file.matchCount += starts.length;
    file.lineCount += 1;
    if (
      file.previewLines.length < REVIEW_FIND_LINES_PER_FILE &&
      shownLines < REVIEW_FIND_MAX_LINES
    ) {
      file.previewLines.push(presentLine(row, code, starts, ends, rowStart));
      shownLines += 1;
    }
  }
  return new ReviewFindResult({
    matchCount,
    files,
    rowIds,
    rowFileIds,
    rowFirstMatch,
    matchRows,
    matchStarts,
    matchEnds,
  });
}

export function resolveReviewFindActiveIndex(
  result: ReviewFindResult,
  active: { readonly rowId: string; readonly start: number } | null,
): number | null {
  if (result.matchCount === 0) return null;
  return Math.max(0, active ? result.indexOf(active.rowId, active.start) : -1);
}

export function stepReviewFindIndex(index: number, direction: 1 | -1, count: number): number {
  return (index + direction + count) % count;
}

export function reviewFindHighlightsJson(
  result: ReviewFindResult,
  activeIndex: number | null,
): string {
  const active = activeIndex === null ? undefined : result.matchAt(activeIndex);
  if (activeIndex === null || active === undefined) return "";
  const first = Math.max(
    0,
    Math.min(
      activeIndex - REVIEW_FIND_HIGHLIGHT_LIMIT / 2,
      result.matchCount - REVIEW_FIND_HIGHLIGHT_LIMIT,
    ),
  );
  const last = Math.min(result.matchCount, first + REVIEW_FIND_HIGHLIGHT_LIMIT);
  const ranges = new Map<string, Array<[number, number]>>();
  for (let index = first; index < last; index++) {
    const match = result.matchAt(index)!;
    const rowRanges = ranges.get(match.rowId);
    if (rowRanges) rowRanges.push([match.start, match.end]);
    else ranges.set(match.rowId, [[match.start, match.end]]);
  }
  return JSON.stringify({
    ranges: Object.fromEntries(ranges),
    active: { rowId: active.rowId, start: active.start, end: active.end },
  });
}
