import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import "~/index.css";

import { render } from "../../../test/render";
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
