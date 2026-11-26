import type { CodeView, FileDiffMetadata } from "@pierre/diffs";
import type { SearchRange } from "@t3tools/shared/paletteSearch";

export type DiffFindMatch = ReturnType<CodeView["getSearchMatches"]>[number];

export type DiffFindLineKind = "addition" | "deletion" | "context";

export interface DiffFindLine {
  readonly key: string;
  readonly kind: DiffFindLineKind;
  readonly lineNumber: number;
  readonly text: string;
  readonly ranges: ReadonlyArray<SearchRange>;
  readonly firstMatchIndex: number;
  readonly matchCount: number;
}

export interface DiffFindFile {
  readonly itemId: string;
  readonly fileDiff: FileDiffMetadata;
  readonly matchCount: number;
  readonly firstMatchIndex: number;
  /** The index of the first match on each matching line. */
  readonly lineStarts: ReadonlyArray<number>;
  readonly lines: ReadonlyArray<DiffFindLine>;
}

export const DIFF_FIND_LINES_PER_FILE = 20;
export const DIFF_FIND_MAX_LINES = 500;
export const DIFF_FIND_SNIPPET_LENGTH = 200;
export const DIFF_FIND_HIGHLIGHTS_PER_LINE = 10;
const LEADING_CONTEXT = 16;

function changedLineIndexes(fileDiff: FileDiffMetadata) {
  const changed = { additions: new Set<number>(), deletions: new Set<number>() };
  for (const hunk of fileDiff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== "change") continue;
      for (let offset = 0; offset < block.additions; offset++) {
        changed.additions.add(block.additionLineIndex + offset);
      }
      for (let offset = 0; offset < block.deletions; offset++) {
        changed.deletions.add(block.deletionLineIndex + offset);
      }
    }
  }
  return changed;
}

function presentLine(
  fileDiff: FileDiffMetadata,
  changed: ReturnType<typeof changedLineIndexes>,
  matches: ReadonlyArray<DiffFindMatch>,
  firstMatchIndex: number,
): DiffFindLine {
  const first = matches[0]!;
  const side = first.side === "deletions" ? "deletions" : "additions";
  const source = side === "deletions" ? fileDiff.deletionLines : fileDiff.additionLines;
  const fullText = (source[first.lineIndex] ?? "").replace(/[\r\n]+$/, "");
  const indent = fullText.length - fullText.trimStart().length;
  const start = Math.min(
    first.startCharacter,
    Math.max(indent, first.startCharacter - LEADING_CONTEXT),
  );
  const end = Math.min(fullText.length, start + DIFF_FIND_SNIPPET_LENGTH);
  const prefix = start > indent ? "…" : "";
  const suffix = end < fullText.length ? "…" : "";
  const ranges: SearchRange[] = [];
  for (const match of matches) {
    if (ranges.length === DIFF_FIND_HIGHLIGHTS_PER_LINE || match.startCharacter >= end) break;
    ranges.push({
      start: match.startCharacter - start + prefix.length,
      end: Math.min(match.endCharacter, end) - start + prefix.length,
    });
  }
  return {
    key: `${side}:${first.lineNumber}`,
    kind: changed[side].has(first.lineIndex)
      ? side === "deletions"
        ? "deletion"
        : "addition"
      : "context",
    lineNumber: first.lineNumber,
    text: prefix + fullText.slice(start, end) + suffix,
    ranges,
    firstMatchIndex,
    matchCount: matches.length,
  };
}

/** Presents the first `count` matching lines of a file, for a file listed past its first lines. */
export function presentDiffFindLines(
  file: Pick<DiffFindFile, "fileDiff" | "matchCount" | "firstMatchIndex" | "lineStarts">,
  matches: ReadonlyArray<DiffFindMatch>,
  count: number,
): DiffFindLine[] {
  const changed = changedLineIndexes(file.fileDiff);
  const fileEnd = file.firstMatchIndex + file.matchCount;
  return file.lineStarts
    .slice(0, count)
    .map((start, line) =>
      presentLine(
        file.fileDiff,
        changed,
        matches.slice(start, file.lineStarts[line + 1] ?? fileEnd),
        start,
      ),
    );
}

export function groupDiffFindMatches(
  matches: ReadonlyArray<DiffFindMatch>,
  getFileDiff: (itemId: string) => FileDiffMetadata | undefined,
): DiffFindFile[] {
  const files: DiffFindFile[] = [];
  let shownLines = 0;
  let index = 0;
  while (index < matches.length) {
    const itemId = matches[index]!.itemId;
    const fileStart = index;
    while (index < matches.length && matches[index]!.itemId === itemId) index++;
    const fileDiff = getFileDiff(itemId);
    if (!fileDiff) continue;
    const lineStarts: number[] = [];
    for (let match = fileStart; match < index; match++) {
      const previous = match === fileStart ? undefined : matches[match - 1];
      const { side, lineNumber } = matches[match]!;
      if (previous === undefined || previous.side !== side || previous.lineNumber !== lineNumber) {
        lineStarts.push(match);
      }
    }
    const file = {
      itemId,
      fileDiff,
      matchCount: index - fileStart,
      firstMatchIndex: fileStart,
      lineStarts,
    };
    const count = Math.min(DIFF_FIND_LINES_PER_FILE, DIFF_FIND_MAX_LINES - shownLines);
    const lines = count > 0 ? presentDiffFindLines(file, matches, count) : [];
    shownLines += lines.length;
    files.push({ ...file, lines });
  }
  return files;
}
