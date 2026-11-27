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
import { useReviewFind } from "./useReviewFind";

it("focuses the find field once per header press, and neither a remount nor reopening by typing replays it", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const latest: { current: ReturnType<typeof useReviewFind> | null } = { current: null };
  function Host(props: { readonly showBar: boolean }) {
    const find = useReviewFind({ rows: [], onReveal: () => {} });
    latest.current = find;
    return props.showBar && find.open ? (
      <ReviewFindBar
        query={find.query}
        result={find.result}
        activeIndex={find.activeIndex}
        focusRequested={find.focusRequested}
        onFocused={find.markFocused}
        resultIsStale={find.resultIsStale}
        partial={false}
        onChangeQuery={find.changeQuery}
        onStep={find.step}
        onClose={find.close}
      />
    ) : null;
  }
  const render = (showBar: boolean) => act(() => root.render(<Host showBar={showBar} />));
  try {
    render(true);
    act(() => latest.current!.changeQuery("app"));
    expect(focus).not.toHaveBeenCalled();

    act(() => latest.current!.openFromHeader());
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => latest.current!.openFromHeader());
    expect(focus).toHaveBeenCalledTimes(2);

    render(false);
    render(true);
    expect(focus).toHaveBeenCalledTimes(2);

    render(false);
    act(() => latest.current!.openFromHeader());
    act(() => latest.current!.close());
    render(true);
    act(() => latest.current!.changeQuery("apple"));
    expect(focus).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
