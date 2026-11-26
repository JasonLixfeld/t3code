import { useAtomValue } from "@effect/atom-react";
import type { CodeView, FileDiffMetadata, SearchPanelState } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useRef, useState } from "react";

import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutEventLike,
} from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { type DiffFindFile, type DiffFindMatch, groupDiffFindMatches } from "./diffFind.logic";

export interface DiffFindState {
  readonly query: string;
  readonly matchCount: number;
  readonly currentMatchIndex: number | undefined;
  readonly matches: ReadonlyArray<DiffFindMatch>;
  readonly files: ReadonlyArray<DiffFindFile>;
}

export interface DiffFind {
  readonly state: DiffFindState | null;
  /** Returns whether a diff was there to open find in. */
  readonly open: () => boolean;
  readonly close: () => void;
  readonly search: (query: string) => void;
  readonly selectMatch: (index: number) => void;
  readonly navigate: (direction: "next" | "previous") => void;
}

// The pull request page's workspace panel has no thread, but its Code tab uses the same binding.
const FIND_CONTEXT = { previewFocus: true };

export function useFindShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return {
    label: shortcutLabelForCommand(keybindings, "preview.find", { context: FIND_CONTEXT }),
    matches: (event: ShortcutEventLike) =>
      resolveShortcutCommand(event, keybindings, { context: FIND_CONTEXT }) === "preview.find",
  };
}

type FindableCodeView = Pick<
  CodeViewHandle<unknown, undefined>,
  "openSearch" | "closeSearch" | "isSearchOpen" | "navigateSearch" | "getItem"
> & {
  getInstance(): Pick<CodeView, "getSearchMatches" | "selectSearchMatch"> | undefined;
};

interface Grouped {
  readonly matches: ReadonlyArray<DiffFindMatch>;
  readonly files: ReadonlyArray<DiffFindFile>;
  readonly lines: ReadonlyArray<readonly [ReadonlyArray<string>, ReadonlyArray<string>]>;
}

export function useDiffFind() {
  const handleRef = useRef<FindableCodeView | null>(null);
  const groupedRef = useRef<Grouped | null>(null);
  const [state, setState] = useState<DiffFindState | null>(null);

  const onSearchStateChange = (next: SearchPanelState | undefined) => {
    const handle = handleRef.current;
    if (!next || !handle) {
      groupedRef.current = null;
      setState(null);
      return;
    }
    const matches = handle.getInstance()?.getSearchMatches() ?? [];
    const getFileDiff = (itemId: string): FileDiffMetadata | undefined => {
      const item = handle.getItem(itemId);
      return item?.type === "diff" ? item.fileDiff : undefined;
    };
    let grouped = groupedRef.current;
    // Pierre keeps its match array when a refresh moves no match, and hydrates a file's
    // metadata in place, so the line arrays show whether a snippet's text changed.
    const isStale = (previous: Grouped) =>
      previous.matches !== matches ||
      previous.files.some((file, index) => {
        const fileDiff = getFileDiff(file.itemId);
        const [additionLines, deletionLines] = previous.lines[index] ?? [];
        return (
          fileDiff !== file.fileDiff ||
          fileDiff.additionLines !== additionLines ||
          fileDiff.deletionLines !== deletionLines
        );
      });
    if (!grouped || isStale(grouped)) {
      const files = groupDiffFindMatches(matches, getFileDiff);
      grouped = {
        matches,
        files,
        lines: files.map((file) => [file.fileDiff.additionLines, file.fileDiff.deletionLines]),
      };
      groupedRef.current = grouped;
    }
    const files = grouped.files;
    setState((previous) =>
      previous?.query === next.text &&
      previous.matchCount === next.matchCount &&
      previous.currentMatchIndex === next.currentMatchIndex &&
      previous.files === files
        ? previous
        : {
            query: next.text,
            matchCount: next.matchCount,
            currentMatchIndex: next.currentMatchIndex,
            matches,
            files,
          },
    );
  };

  const find: DiffFind = {
    state,
    open: () => {
      const handle = handleRef.current;
      if (!handle) return false;
      handle.openSearch({ scope: "all", mode: "find" });
      return true;
    },
    close: () => handleRef.current?.closeSearch(),
    search: (query) => {
      const handle = handleRef.current;
      if (!handle || (query === "" && !handle.isSearchOpen())) return;
      handle.openSearch({ scope: "all", mode: "find", query, focus: false });
    },
    selectMatch: (index) => handleRef.current?.getInstance()?.selectSearchMatch(index),
    navigate: (direction) => handleRef.current?.navigateSearch(direction),
  };

  return {
    find,
    attach: (handle: FindableCodeView | null) => {
      handleRef.current = handle;
    },
    /** Pierre's own find keys stay off so the configured binding opens find everywhere. */
    codeViewOptions: {
      onSearchStateChange,
      searchOptions: { disableShortcuts: true },
    },
  };
}
