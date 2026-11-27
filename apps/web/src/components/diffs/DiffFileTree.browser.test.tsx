import { parsePatchFiles } from "@pierre/diffs";
import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import "~/index.css";

import { render } from "../../../test/render";
import { groupDiffFindMatches } from "./diffFind.logic";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { type DiffFind, matchesFindShortcut } from "./useDiffFind";

const FOLDERS = 300;

it("expands every folder without asking the tree about all folders for each one", async () => {
  // Two levels, so flattening empty folders cannot merge them into one.
  const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
    { path: `package-${index}/a.ts`, status: "modified" as const },
    { path: `package-${index}/lib/b.ts`, status: "modified" as const },
  ]).flat();
  using getItem = vi.spyOn(FileTree.prototype, "getItem");
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />
    </div>,
  );
  const collapseAll = page.getByRole("button", { name: "Collapse all folders" });
  await expect.element(collapseAll).toBeVisible();
  await userEvent.click(collapseAll);
  const expandAll = page.getByRole("button", { name: "Expand all folders" });
  await expect.element(expandAll).toBeVisible();
  getItem.mockClear();
  await userEvent.click(expandAll);
  await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
  // Each of the expansions used to look up the folders again from the first one, so the lookups
  // grew with the square of the folder count (hundreds of thousands at 600 folders).
  expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
});

it("types a letter that is also the find binding into the Files search", async () => {
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "f", command: "preview.find", when: "previewFocus" },
  ]);
  const find: DiffFind = {
    state: null,
    open: () => false,
    close: () => {},
    search: () => {},
    selectMatch: () => {},
    navigate: () => {},
    shortcutLabel: null,
    matchesShortcut: (event) => matchesFindShortcut(event, keybindings, {}),
  };
  await using screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree
        entries={[{ path: "src/foo.ts", status: "modified" }]}
        onSelectFile={() => {}}
        ariaLabel="Changed files"
        find={find}
      />
    </div>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Search files" }));
  const search = screen.getByRole("searchbox", { name: "Filter files by name" });
  await userEvent.type(search, "foo");
  await expect.element(search).toHaveValue("foo");
});

it("keeps Contents results with a long line inside a narrow file column", async () => {
  const line = `const hit = ${"x".repeat(180)};`;
  const fileDiff = parsePatchFiles(
    `diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -0,0 +1 @@\n+${line}\n`,
  )[0]!.files[0]!;
  const matches = [
    {
      itemId: "foo",
      itemType: "diff" as const,
      side: "additions" as const,
      lineNumber: 1,
      lineIndex: 0,
      startCharacter: 6,
      endCharacter: 9,
    },
  ];
  const find: DiffFind = {
    state: {
      query: "hit",
      matchCount: 1,
      currentMatchIndex: 0,
      matches,
      files: groupDiffFindMatches(matches, () => fileDiff),
    },
    open: () => false,
    close: () => {},
    search: () => {},
    selectMatch: () => {},
    navigate: () => {},
    shortcutLabel: null,
    matchesShortcut: () => false,
  };
  await using screen = await render(
    <div data-testid="column" className="flex h-[600px] w-[200px]">
      <DiffFileTree
        entries={[{ path: "src/foo.ts", status: "modified" }]}
        onSelectFile={() => {}}
        ariaLabel="Changed files"
        find={find}
      />
    </div>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Search files" }));
  await userEvent.click(screen.getByRole("button", { name: "Contents" }));
  await expect.element(screen.getByRole("button", { name: /const hit/ })).toBeVisible();
  const column = screen.getByTestId("column").element();
  const columnRight = column.getBoundingClientRect().right;
  const closeButton = screen.getByRole("button", { name: "Close file search" }).element();
  expect(closeButton.getBoundingClientRect().right).toBeLessThanOrEqual(columnRight);
  expect(column.firstElementChild!.getBoundingClientRect().right).toBeLessThanOrEqual(columnRight);
});
