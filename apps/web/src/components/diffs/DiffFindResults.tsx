import { splitSearchText } from "@t3tools/shared/paletteSearch";
import { T, useGT } from "gt-react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import type { DiffFindLine } from "./diffFind.logic";
import type { DiffFind } from "./useDiffFind";

const LINE_MARKERS: Record<DiffFindLine["kind"], string> = {
  addition: "+",
  deletion: "−",
  context: "",
};

export function DiffFindResults({
  find,
  onSelectFile,
}: {
  readonly find: DiffFind;
  readonly onSelectFile: (path: string) => void;
}) {
  const gt = useGT();
  const state = find.state;
  if (!state?.query) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        <T>Type to search the changed lines.</T>
      </p>
    );
  }
  if (state.files.length === 0) {
    return (
      <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
        <T>No changed lines match.</T>
      </p>
    );
  }
  const current = state.currentMatchIndex;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2 text-xs" data-diff-find-results>
      {state.files.map((file) => {
        const path = resolveFileDiffPath(file.fileDiff);
        const slash = path.lastIndexOf("/");
        return (
          <section key={file.itemId} aria-label={path}>
            <button
              type="button"
              className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left hover:bg-accent"
              onClick={() => onSelectFile(path)}
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
            {file.lines.map((line) => {
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
            {file.hiddenLineCount > 0 ? (
              <p className="ps-14 pe-2 py-0.5 text-2xs text-muted-foreground">
                {gt("{count, plural, one {{count} more line} other {{count} more lines}}", {
                  count: file.hiddenLineCount,
                })}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
