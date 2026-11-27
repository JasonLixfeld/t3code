import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import { useReviewFind } from "./useReviewFind";

const rows: NativeReviewDiffRow[] = [
  { kind: "line", id: "a:line:0", fileId: "a", content: "app apple", change: "context" },
];

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onReveal = vi.fn();
  const latest: { current: ReturnType<typeof useReviewFind> | null } = { current: null };
  function Probe(props: { readonly rows: ReadonlyArray<NativeReviewDiffRow> }) {
    latest.current = useReviewFind({ rows: props.rows, onReveal });
    return null;
  }
  act(() => root.render(<Probe rows={rows} />));
  const find = () => latest.current!;
  return {
    find,
    onReveal,
    run(action: (find: ReturnType<typeof useReviewFind>) => void) {
      act(() => action(find()));
    },
    loadRows(next: ReadonlyArray<NativeReviewDiffRow>) {
      act(() => root.render(<Probe rows={next} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("searches only while Find or the Contents search is open", () => {
  using screen = setup();
  screen.run((find) => find.changeQuery("app"));
  expect(screen.find().result.matchCount).toBe(2);

  screen.run((find) => find.close());
  expect(screen.find().result.matchCount).toBe(0);

  screen.run((find) => find.setContentsSearchOpen(true));
  expect(screen.find().result.matchCount).toBe(2);
});

it("reveals the first match, each step with wrap-around, and the exact match chosen under an older query", () => {
  using screen = setup();

  screen.run((find) => find.changeQuery("app"));
  expect(screen.onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ start: 0 }));

  screen.run((find) => find.step(-1));
  expect(screen.find().activeIndex).toBe(1);
  expect(screen.onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ start: 4 }));

  const chosen = screen.find().result.matchAt(1)!;
  screen.run((find) => find.changeQuery("appl"));
  screen.run((find) => find.selectMatch(chosen));
  expect(screen.onReveal).toHaveBeenLastCalledWith(chosen);
  expect(chosen).toMatchObject({ start: 4, end: 7 });
});

it("keeps the revealed match when an earlier file's rows load, and replaces it only when it goes", () => {
  using screen = setup();
  screen.run((find) => find.changeQuery("apple"));
  expect(screen.onReveal).toHaveBeenCalledTimes(1);
  const earlier: NativeReviewDiffRow = {
    kind: "line",
    id: "0:line:0",
    fileId: "0",
    content: "apple",
    change: "context",
  };

  screen.loadRows([earlier, ...rows]);
  expect(screen.find().activeIndex).toBe(1);
  expect(screen.onReveal).toHaveBeenCalledTimes(1);

  screen.loadRows([earlier]);
  expect(screen.find().activeIndex).toBe(0);
  expect(screen.onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ rowId: "0:line:0" }));
  expect(screen.onReveal).toHaveBeenCalledTimes(2);
});
