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
  readonly lines: ReadonlyArray<DiffFindLine>;
  readonly hiddenLineCount: number;
}

export const DIFF_FIND_LINES_PER_FILE = 20;
const DIFF_FIND_MAX_LINES = 500;
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
  // Start a long line near its first match so the match stays inside the clipped row.
  const start = Math.max(indent, first.startCharacter - LEADING_CONTEXT);
  const clipped = start > indent;
  const prefix = clipped ? "…" : "";
  return {
    key: `${side}:${first.lineNumber}`,
    kind: changed[side].has(first.lineIndex)
      ? side === "deletions"
        ? "deletion"
        : "addition"
      : "context",
    lineNumber: first.lineNumber,
    text: prefix + fullText.slice(start),
    ranges: matches.map((match) => ({
      start: match.startCharacter - start + prefix.length,
      end: match.endCharacter - start + prefix.length,
    })),
    firstMatchIndex,
    matchCount: matches.length,
  };
}

/** Groups the diff find's matches by file and line, in the order the diff find steps through them. */
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
    const changed = changedLineIndexes(fileDiff);
    const lines: DiffFindLine[] = [];
    let lineCount = 0;
    let lineStart = fileStart;
    while (lineStart < index) {
      const { side, lineNumber } = matches[lineStart]!;
      let lineEnd = lineStart + 1;
      while (
        lineEnd < index &&
        matches[lineEnd]!.side === side &&
        matches[lineEnd]!.lineNumber === lineNumber
      ) {
        lineEnd++;
      }
      if (lines.length < DIFF_FIND_LINES_PER_FILE && shownLines < DIFF_FIND_MAX_LINES) {
        lines.push(presentLine(fileDiff, changed, matches.slice(lineStart, lineEnd), lineStart));
        shownLines++;
      }
      lineCount++;
      lineStart = lineEnd;
    }
    files.push({
      itemId,
      fileDiff,
      matchCount: index - fileStart,
      lines,
      hiddenLineCount: lineCount - lines.length,
    });
  }
  return files;
}
