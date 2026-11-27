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
  View: ({ children, style }: { children?: ReactNode; style?: { paddingTop?: number } }) => (
    <div data-padding-top={style?.paddingTop}>{children}</div>
  ),
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
vi.mock("../../components/ui/PaneListItem", () => ({
  PaneListItem: (props: { children: ReactNode; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
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
  const onSelectMatch = vi.fn();
  const onChangeQuery = vi.fn();
  const render = (query: string) => {
    const find: ReviewFileNavigatorFind = {
      query,
      result: findInReviewRows(rows, query),
      activeIndex: null,
      partial: false,
      onChangeQuery,
      onSelectMatch,
    };
    act(() =>
      root.render(
        <InspectorSheetContext value={closeSheet}>
          <ReviewFileNavigator files={files} sectionId="s" onSelectFile={() => {}} find={find} />
        </InspectorSheetContext>,
      ),
    );
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
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it("keeps the pinned search controls below the bar that floats over the inspector", () => {
  using screen = setup();
  screen.render("");

  const controls = screen.container.querySelector("input")!.closest("[data-padding-top]");
  expect(controls?.getAttribute("data-padding-top")).toBe("52");
});

it("filters files by path, including files whose rows have not loaded", () => {
  using screen = setup();
  screen.render("");

  screen.type("SRC/");

  expect(screen.buttons().map((button) => button.textContent)).toEqual([
    "src/app.ts+2-1",
    "src/unloaded.ts+9-0",
  ]);
});

it("searches contents with the find query and lists counts and matching lines", () => {
  using screen = setup();
  screen.render("");
  screen.type("app");

  screen.chooseMode("Contents");
  expect(screen.onChangeQuery).toHaveBeenLastCalledWith("app");
  screen.render("app");

  expect(screen.buttons().map((button) => button.textContent)).toEqual([
    "src/app.ts2",
    "12+const app = createApp();",
    "docs/guide.md3",
    "3 Run the app twice: app, app.",
  ]);
  screen.type("twice");
  expect(screen.onChangeQuery).toHaveBeenLastCalledWith("twice");
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
  expect(screen.onSelectMatch).toHaveBeenCalledWith(2);
});
