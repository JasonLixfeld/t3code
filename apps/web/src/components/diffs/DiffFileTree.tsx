import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { T, useGT } from "gt-react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import {
  PIERRE_TREE_UNSAFE_CSS,
  pierreTreeStyle,
  titleClippedPierreTreeRow,
} from "~/pierre-tree-theme";

import {
  areAllDirectoriesExpanded,
  setAllDirectoriesExpanded,
  subscribeOncePerTask,
} from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";
import { diffFileTreePositions } from "@t3tools/client-runtime/diff-file-order";
import { DiffFindResults } from "./DiffFindResults";
import { type DiffFind, useFindShortcut } from "./useDiffFind";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly find?: DiffFind;
}

type SearchMode = "name" | "contents";

export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
  find,
}: DiffFileTreeProps) {
  const gt = useGT();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("name");
  const [nameQuery, setNameQueryState] = useState("");
  const findShortcut = useFindShortcut();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const contentsMode = searchOpen && searchMode === "contents" && find !== undefined;
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const presented = diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = diffFileTreePositions(modelPaths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: presented.modelPath(entry.path),
    status: entry.status,
  }));
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
  } | null>(null);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useSyncExternalStore(
    (listener) => subscribeOncePerTask(model, listener),
    () => areAllDirectoriesExpanded(model, directoryPaths),
  );
  const nameSearch = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const noNameMatches =
    searchOpen && nameQuery.trim() !== "" && nameSearch.matchingPaths.length === 0;

  const focusSearch = () => {
    if (!searchOpen) {
      setSearchOpen(true);
      return;
    }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };
  // Pierre trims and lowercases the value it keeps, so the input shows its own copy.
  const setNameQuery = (value: string) => {
    setNameQueryState(value);
    if (value.trim() === "") nameSearch.close();
    else nameSearch.setValue(value);
  };
  const closeSearch = () => {
    setNameQuery("");
    setSearchOpen(false);
  };
  const changeSearchMode = (mode: SearchMode) => {
    if (mode === searchMode || find === undefined) return;
    setSearchMode(mode);
    if (mode === "name") {
      setNameQuery(find.state?.query ?? "");
    } else {
      const query = nameQuery;
      setNameQuery("");
      if (query !== "") find.search(query, searchInputRef.current);
    }
    searchInputRef.current?.focus();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the icon set into the imperative Pierre file tree model
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies path updates, ordering and git status to the imperative Pierre file tree model
  useEffect(() => {
    ordering.update(positions);
    const mounted = mountedPresentationRef.current;
    if (mounted?.paths === modelPaths) return;
    mountedPresentationRef.current = presented;
    if (mounted === null) {
      model.resetPaths(modelPaths);
    } else if (mounted.paths.every((path, index) => modelPaths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so paging keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null ? null : presented.modelPath(mounted.selectionPath(focusedPath));
      const selectedPaths = model
        .getSelectedPaths()
        .map((path) => presented.modelPath(mounted.selectionPath(path)))
        .filter((path) => path.endsWith("/") || modelPaths.includes(path));
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      syncingSelectionRef.current = true;
      // A reset keeps old search matches, so search closes first and recomputes afterwards.
      const activeSearch = model.isSearchOpen() ? model.getSearchValue() : null;
      if (activeSearch !== null) model.closeSearch();
      model.resetPaths(modelPaths);
      if (activeSearch !== null) model.setSearch(activeSearch);
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      for (const path of selectedPaths) model.getItem(path)?.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
      if (
        nextFocusedPath !== null &&
        (modelPaths.includes(nextFocusedPath) || directoryPaths.includes(nextFocusedPath))
      ) {
        model.focusPath(nextFocusedPath);
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions, presented]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands ancestors, selects and scrolls to the requested file in the Pierre tree model
  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const modelPath = presented.modelPath(selectedPath);
    const item = model.getItem(modelPath);
    if (item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) {
      return;
    }
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== modelPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of modelPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(modelPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [model, presented, revealRequestId, selectedPath]);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && searchOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
          searchButtonRef.current?.focus();
        } else if (findShortcut.matches(event.nativeEvent)) {
          event.preventDefault();
          focusSearch();
        }
      }}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">
          <T>Files</T>
        </span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                ref={searchButtonRef}
                aria-label={gt("Search files")}
                variant="ghost"
                size="xs"
                pressed={searchOpen}
                onPressedChange={(pressed) => (pressed ? focusSearch() : closeSearch())}
              />
            }
          >
            <SearchIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{gt("Search files")}</TooltipPopup>
        </Tooltip>
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? gt("Collapse all folders") : gt("Expand all folders")
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? gt("Collapse all folders") : gt("Expand all folders")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {searchOpen ? (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-2 py-1.5">
          <div className="flex items-center gap-1">
            <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
              <InputGroupInput
                ref={searchInputRef}
                type="text"
                role="searchbox"
                name="diff-files-search"
                size="sm"
                autoFocus
                spellCheck={false}
                aria-label={
                  contentsMode ? gt("Search lines in the diff") : gt("Filter files by name")
                }
                placeholder={
                  contentsMode ? gt("Search lines in the diff") : gt("Filter by file name")
                }
                value={contentsMode ? (find.state?.query ?? "") : nameQuery}
                onChange={(event) =>
                  contentsMode
                    ? find.search(event.target.value, event.currentTarget)
                    : setNameQuery(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && contentsMode) {
                    event.preventDefault();
                    find.navigate(event.shiftKey ? "previous" : "next");
                  }
                }}
              />
            </InputGroup>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Close file search")}
              onClick={closeSearch}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          {find ? (
            <ToggleGroup
              aria-label={gt("Search by")}
              value={[searchMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "name" || next === "contents") changeSearchMode(next);
              }}
            >
              <Toggle value="name">
                <T context="search files by file name">Name</T>
              </Toggle>
              <Toggle value="contents">
                <T context="search files by the lines in their diff">Contents</T>
              </Toggle>
            </ToggleGroup>
          ) : null}
        </div>
      ) : null}
      {contentsMode ? (
        <DiffFindResults find={find} />
      ) : noNameMatches ? (
        <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
          <T>No matching files.</T>
        </p>
      ) : (
        <FileTree
          model={model}
          aria-label={ariaLabel}
          onClickCapture={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            // Pierre emits no change for its sole selected row; read before the click to avoid double reveals.
            const selected = model.getSelectedPaths();
            const path = selected.length === 1 ? selected[0] : undefined;
            if (!path || !modelPaths.includes(path)) return;
            const clickedSelectedRow = event.nativeEvent
              .composedPath()
              .some(
                (node) =>
                  node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
              );
            if (clickedSelectedRow) onSelectFile(presented.selectionPath(path));
          }}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
          onPointerOver={titleClippedPierreTreeRow}
        />
      )}
      {footer}
    </div>
  );
}
