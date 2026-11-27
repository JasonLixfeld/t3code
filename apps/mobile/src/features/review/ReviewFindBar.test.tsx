import { act, type ReactNode, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const focus = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ContentBand", () => ({
  ContentBand: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: { inputRef: RefObject<{ focus: () => void } | null> }) => {
    props.inputRef.current = { focus };
    return null;
  },
}));

import { ReviewFindBar } from "./ReviewFindBar";
import { EMPTY_REVIEW_FIND_RESULT } from "./reviewFind";

it("focuses the open find field on each header press, but not when it opens from Contents", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const render = (focusRequestId: number) =>
    act(() =>
      root.render(
        <ReviewFindBar
          query="app"
          result={EMPTY_REVIEW_FIND_RESULT}
          activeIndex={null}
          focusRequestId={focusRequestId}
          resultIsStale={false}
          partial={false}
          onChangeQuery={() => {}}
          onStep={() => {}}
          onClose={() => {}}
        />,
      ),
    );
  try {
    render(0);
    expect(focus).not.toHaveBeenCalled();
    render(1);
    render(1);
    expect(focus).toHaveBeenCalledTimes(1);
    render(2);
    expect(focus).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
