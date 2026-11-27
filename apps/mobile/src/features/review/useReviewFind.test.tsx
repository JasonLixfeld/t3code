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
  function Probe() {
    latest.current = useReviewFind({ rows, onReveal });
    return null;
  }
  act(() => root.render(<Probe />));
  const find = () => latest.current!;
  return {
    find,
    onReveal,
    run(action: (find: ReturnType<typeof useReviewFind>) => void) {
      act(() => action(find()));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("autofocuses the find field only when it is opened from the header", () => {
  using screen = setup();

  screen.run((find) => find.changeQuery("app"));
  expect(screen.find().open).toBe(true);
  expect(screen.find().autoFocus).toBe(false);

  screen.run((find) => find.close());
  screen.run((find) => find.openFromHeader());
  expect(screen.find().autoFocus).toBe(true);
});

it("steps through matches with wrap-around and reveals each one", () => {
  using screen = setup();

  screen.run((find) => find.changeQuery("app"));
  expect(screen.onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ start: 0 }));

  screen.run((find) => find.step(-1));
  expect(screen.find().activeIndex).toBe(1);
  expect(screen.onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ start: 4 }));
});

it("reveals the exact match chosen under an older query", () => {
  using screen = setup();
  screen.run((find) => find.changeQuery("app"));
  const chosen = screen.find().result.matches[1]!;

  screen.run((find) => find.changeQuery("appl"));
  screen.run((find) => find.selectMatch(chosen));

  expect(screen.onReveal).toHaveBeenLastCalledWith(chosen);
  expect(chosen).toMatchObject({ start: 4, end: 7 });
});
