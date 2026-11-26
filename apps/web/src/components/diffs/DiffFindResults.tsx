import { splitSearchText } from "@t3tools/shared/paletteSearch";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import {
  DIFF_FIND_MAX_LINES,
  type DiffFindLine,
  type DiffFindMatch,
  presentDiffFindLines,
} from "./diffFind.logic";
import type { DiffFind } from "./useDiffFind";

const LINE_MARKERS: Record<DiffFindLine["kind"], string> = {
  addition: "+",
  deletion: "−",
  context: "",
};

export function DiffFindResults({ find }: { readonly find: DiffFind }) {
  const gt = useGT();
  const [expanded, setExpanded] = useState<{
    readonly matches: ReadonlyArray<DiffFindMatch>;
    readonly lineCounts: ReadonlyMap<string, number>;
  } | null>(null);
  const state = find.state;
  if (!state?.query) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        <T>Type to search the lines in the diff.</T>
      </p>
    );
  }
  if (state.files.length === 0) {
    return (
      <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
        <T>No lines in the diff match.</T>
      </p>
    );
  }
  const current = state.currentMatchIndex;
  const lineCounts = expanded?.matches === state.matches ? expanded.lineCounts : undefined;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2 text-xs" data-diff-find-results>
      {state.files.map((file) => {
        const path = resolveFileDiffPath(file.fileDiff);
        const slash = path.lastIndexOf("/");
        const expandedCount = lineCounts?.get(file.itemId);
        const lines =
          expandedCount === undefined
            ? file.lines
            : presentDiffFindLines(file, state.matches, expandedCount);
        const hiddenLineCount = file.lineStarts.length - lines.length;
        return (
          <section key={file.itemId} aria-label={path}>
            <button
              type="button"
              className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left hover:bg-accent"
              onClick={() => find.selectMatch(file.firstMatchIndex)}
            >
              <span className="shrink-0 font-medium text-foreground">{path.slice(slash + 1)}</span>
              <span className="min-w-0 truncate text-muted-foreground">
                {path.slice(0, Math.max(slash, 0))}
              </span>
              <span
                className="ml-auto shrink-0 tabular-nums text-muted-foreground"
                data-diff-find-file-count
              >
                {file.matchCount}
              </span>
            </button>
            {lines.map((line) => {
              const isCurrent =
                current !== undefined &&
                current >= line.firstMatchIndex &&
                current < line.firstMatchIndex + line.matchCount;
              return (
                <button
                  key={line.key}
                  type="button"
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn(
                    "flex h-6 w-full min-w-0 items-center gap-1.5 ps-3 pe-2 text-left font-mono text-2xs hover:bg-accent",
                    isCurrent && "bg-accent",
                  )}
                  onClick={() => find.selectMatch(line.firstMatchIndex)}
                >
                  <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                    {line.lineNumber}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-2 shrink-0 text-center",
                      line.kind === "addition" && "text-diff-addition-foreground",
                      line.kind === "deletion" && "text-diff-deletion-foreground",
                    )}
                  >
                    {LINE_MARKERS[line.kind]}
                  </span>
                  <span className="min-w-0 truncate whitespace-pre text-foreground">
                    {splitSearchText(line.text, line.ranges).map((part) =>
                      part.highlighted ? (
                        <mark key={part.start} className="rounded-xs bg-warning/20 text-foreground">
                          {part.text}
                        </mark>
                      ) : (
                        part.text
                      ),
                    )}
                  </span>
                </button>
              );
            })}
            {hiddenLineCount > 0 ? (
              <button
                type="button"
                className="flex h-6 w-full items-center ps-14 pe-2 text-left text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() =>
                  setExpanded({
                    matches: state.matches,
                    lineCounts: new Map(lineCounts).set(
                      file.itemId,
                      lines.length + DIFF_FIND_MAX_LINES,
                    ),
                  })
                }
              >
                {gt("{count, plural, one {{count} more line} other {{count} more lines}}", {
                  count: hiddenLineCount,
                })}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
