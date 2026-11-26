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
  readonly files: ReadonlyArray<DiffFindFile>;
}

export interface DiffFind {
  readonly state: DiffFindState | null;
  readonly open: () => void;
  readonly close: () => void;
  readonly search: (query: string, input: HTMLInputElement | null) => void;
  readonly selectMatch: (index: number) => void;
  readonly navigate: (direction: "next" | "previous") => void;
}

// The standalone pull request page has no right panel, but its Code tab uses the same binding.
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

export function useDiffFind() {
  const handleRef = useRef<FindableCodeView | null>(null);
  const groupedRef = useRef<{
    matches: ReadonlyArray<DiffFindMatch>;
    files: ReadonlyArray<DiffFindFile>;
  } | null>(null);
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
    // Pierre keeps its match array when a refresh moves no match, even if the line text changed.
    if (
      grouped?.matches !== matches ||
      grouped.files.some((file) => getFileDiff(file.itemId) !== file.fileDiff)
    ) {
      grouped = { matches, files: groupDiffFindMatches(matches, getFileDiff) };
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
            files,
          },
    );
  };

  const open = () => handleRef.current?.openSearch({ scope: "all", mode: "find" });

  const find: DiffFind = {
    state,
    open,
    close: () => handleRef.current?.closeSearch(),
    search: (query, input) => {
      const handle = handleRef.current;
      if (!handle || (query === "" && !handle.isSearchOpen())) return;
      handle.openSearch({ scope: "all", mode: "find", query });
      input?.focus();
    },
    selectMatch: (index) => handleRef.current?.getInstance()?.selectSearchMatch(index),
    navigate: (direction) => handleRef.current?.navigateSearch(direction),
  };

  return {
    find,
    attach: (handle: FindableCodeView | null) => {
      handleRef.current = handle;
    },
    onSearchStateChange,
  };
}
