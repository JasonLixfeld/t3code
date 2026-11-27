import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import type { ReviewFileNavigatorFind } from "./ReviewFileNavigator";
import { findInReviewRows } from "./reviewFind";

vi.mock("@legendapp/list/react-native", () => ({
  LegendList: <Item,>(props: {
    data: ReadonlyArray<Item>;
    renderItem: (input: { item: Item }) => ReactNode;
    keyExtractor: (item: Item) => string;
  }) => (
    <ul>
      {props.data.map((item) => (
        <li key={props.keyExtractor(item)}>{props.renderItem({ item })}</li>
      ))}
    </ul>
  ),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/useBarInset", () => ({ useBarOverlap: () => 44 }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/SheetPane", () => ({
  SheetPane: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
const paneListItemRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../components/ui/PaneListItem", () => ({
  PaneListItem: (props: { children: ReactNode; onPress: () => void }) => {
    paneListItemRenders.count += 1;
    return (
      <button data-render={paneListItemRenders.count} onClick={props.onPress}>
        {props.children}
      </button>
    );
  },
}));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: { value: string; onChangeText: (value: string) => void }) => (
    <input value={props.value} onChange={(event) => props.onChangeText(event.target.value)} />
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({
  SegmentedControl: (props: {
    options: ReadonlyArray<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) => (
    <nav>
      {props.options.map((option) => (
        <a key={option.value} onClick={() => props.onSelect(option.value)}>
          {option.label}
        </a>
      ))}
    </nav>
  ),
}));
vi.mock("./ReviewFindBar", () => ({ ReviewFindPartialHint: () => null }));
const panes = vi.hoisted(() => ({ auxiliaryPaneVisible: true }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({ useWorkspacePaneState: () => ({ panes }) }));
vi.mock("../layout/workspace-inspector-sheet", async () => {
  const { createContext } = await import("react");
  return { InspectorSheetContext: createContext<((then?: () => void) => void) | null>(null) };
});

import { ReviewFileNavigator } from "./ReviewFileNavigator";

const files = [
  { id: "src/app.ts", path: "src/app.ts", additions: 2, deletions: 1 },
  { id: "docs/guide.md", path: "docs/guide.md", additions: 4, deletions: 0 },
  { id: "src/unloaded.ts", path: "src/unloaded.ts", additions: 9, deletions: 0 },
];
const rows: NativeReviewDiffRow[] = [
  { kind: "file", id: "src/app.ts:header", fileId: "src/app.ts" },
  {
    kind: "line",
    id: "src/app.ts:line:0",
    fileId: "src/app.ts",
    content: "const app = createApp();",
    change: "add",
    newLineNumber: 12,
  },
  { kind: "file", id: "docs/guide.md:header", fileId: "docs/guide.md" },
  {
    kind: "line",
    id: "docs/guide.md:line:0",
    fileId: "docs/guide.md",
    content: "Run the app twice: app, app.",
    change: "context",
    newLineNumber: 3,
  },
];

function setup(closeSheet: ((then?: () => void) => void) | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let findQuery = "";
  let activeIndex: number | null = null;
  const results = new Map<string, ReturnType<typeof findInReviewRows>>();
  const resultFor = (query: string) => {
    if (!results.has(query)) results.set(query, findInReviewRows(rows, query));
    return results.get(query)!;
  };
  const onSelectMatch = vi.fn();
  const onContentsSearchOpenChange = vi.fn();
  const tree = () => {
    const find: ReviewFileNavigatorFind = {
      query: findQuery,
      result: resultFor(findQuery),
      activeIndex,
      partial: false,
      onChangeQuery,
      onSelectMatch,
      onContentsSearchOpenChange,
    };
    return (
      <InspectorSheetContext value={closeSheet}>
        <ReviewFileNavigator files={files} sectionId="s" onSelectFile={() => {}} find={find} />
      </InspectorSheetContext>
    );
  };
  const onChangeQuery = vi.fn((query: string) => {
    findQuery = query;
    root.render(tree());
  });
  const render = (query: string, active: number | null = null) => {
    findQuery = query;
    activeIndex = active;
    act(() => root.render(tree()));
  };
  const type = (value: string) => {
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const chooseMode = (label: string) => {
    const tab = [...container.querySelectorAll("nav a")].find((a) => a.textContent === label)!;
    act(() => (tab as HTMLElement).click());
  };
  const buttons = () => [...container.querySelectorAll("button")];
  return {
    container,
    render,
    type,
    chooseMode,
    buttons,
    onSelectMatch,
    onChangeQuery,
    onContentsSearchOpenChange,
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it("filters files by path, including files whose rows have not loaded", () => {
  using screen = setup();
  screen.render("");

  screen.type("SRC/");

  expect(screen.buttons().map((button) => button.querySelector("span")?.textContent)).toEqual([
    "src/app.ts",
    "src/unloaded.ts",
  ]);
});

it("switches modes like the web diff: Contents takes typed Name text, Name takes the find query", () => {
  using screen = setup();
  screen.render("app");
  const input = () => screen.container.querySelector("input")!.value;

  screen.chooseMode("Contents");
  expect(screen.onChangeQuery).not.toHaveBeenCalled();
  expect(input()).toBe("app");
  screen.chooseMode("Name");
  expect(input()).toBe("app");

  screen.type("SRC");
  screen.chooseMode("Contents");
  expect(screen.onChangeQuery).toHaveBeenLastCalledWith("SRC");
  expect(input()).toBe("SRC");
  screen.type("");

  screen.chooseMode("Name");
  expect(input()).toBe("");
});

it("re-renders only the Contents group that holds the active match when stepping", () => {
  using screen = setup();
  screen.render("app", 0);
  screen.chooseMode("Contents");

  const renders = () =>
    [...screen.container.querySelectorAll("li")].map((group) =>
      [...group.querySelectorAll("button")].map((row) => row.dataset.render).join(),
    );
  const before = renders();
  screen.render("app", 1);

  expect(renders().map((group, index) => group !== before[index])).toEqual([true, false]);
});

it("reports Contents open only while the inspector column shows it", () => {
  panes.auxiliaryPaneVisible = false;
  try {
    using screen = setup();
    screen.render("app");
    screen.chooseMode("Contents");
    expect(screen.onContentsSearchOpenChange).not.toHaveBeenCalledWith(true);

    panes.auxiliaryPaneVisible = true;
    screen.render("app");
    expect(screen.onContentsSearchOpenChange).toHaveBeenLastCalledWith(true);

    panes.auxiliaryPaneVisible = false;
    screen.render("app");
    expect(screen.onContentsSearchOpenChange).toHaveBeenLastCalledWith(false);
  } finally {
    panes.auxiliaryPaneVisible = true;
  }
});

it("closes the inspector sheet before jumping to a chosen match", () => {
  let afterClose: (() => void) | undefined;
  using screen = setup((then) => {
    afterClose = then;
  });
  screen.render("app");
  screen.chooseMode("Contents");

  const guideLine = screen.buttons().find((button) => button.textContent?.startsWith("3 Run"))!;
  act(() => guideLine.click());

  expect(screen.onSelectMatch).not.toHaveBeenCalled();
  act(() => afterClose?.());
  expect(screen.onSelectMatch).toHaveBeenCalledWith(findInReviewRows(rows, "app").matchAt(2));
});
