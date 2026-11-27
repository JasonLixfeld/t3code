import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import {
  findInReviewRows,
  resolveReviewFindActiveIndex,
  reviewFindHighlightsJson,
  stepReviewFindIndex,
  type ReviewFindMatch,
} from "./reviewFind";

export function useReviewFind(input: {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly onReveal: (match: ReviewFindMatch) => void;
}) {
  const [state, setState] = useState<{
    readonly open: boolean;
    readonly autoFocus: boolean;
    readonly query: string;
    readonly chosenMatch: ReviewFindMatch | null;
    readonly revealRequestId: number;
  }>({ open: false, autoFocus: false, query: "", chosenMatch: null, revealRequestId: 0 });
  const searchedQuery = useDeferredValue(state.query);
  const result = useMemo(
    () => findInReviewRows(input.rows, searchedQuery),
    [input.rows, searchedQuery],
  );
  const resultIsStale = searchedQuery !== state.query;
  const activeIndex = resolveReviewFindActiveIndex(result.matches, state.chosenMatch);
  const revealTarget =
    state.chosenMatch ?? (resultIsStale || activeIndex === null ? undefined : result.matches[0]);
  const highlightsJson = useMemo(
    () => (state.open ? reviewFindHighlightsJson(result.matches, activeIndex) : ""),
    [state.open, result.matches, activeIndex],
  );

  const selectMatch = (match: ReviewFindMatch) =>
    setState((current) => ({
      ...current,
      open: true,
      autoFocus: current.open && current.autoFocus,
      chosenMatch: match,
      revealRequestId: current.revealRequestId + 1,
    }));
  const changeQuery = (query: string) =>
    setState((current) => ({
      open: true,
      autoFocus: current.open && current.autoFocus,
      query,
      chosenMatch: null,
      revealRequestId: current.revealRequestId + 1,
    }));
  const step = (direction: 1 | -1) => {
    if (resultIsStale || activeIndex === null) return;
    const match =
      result.matches[stepReviewFindIndex(activeIndex, direction, result.matches.length)];
    if (match) selectMatch(match);
  };
  const openFromHeader = () => setState((current) => ({ ...current, open: true, autoFocus: true }));
  const close = () => setState((current) => ({ ...current, open: false }));

  const lastRevealedRequestId = useRef(-1);
  const reveal = useEffectEvent(() => {
    if (!revealTarget) return;
    lastRevealedRequestId.current = state.revealRequestId;
    input.onReveal(revealTarget);
  });
  const hasRevealTarget = revealTarget !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the native diff once a requested match is known
  useEffect(() => {
    if (
      !state.open ||
      !hasRevealTarget ||
      lastRevealedRequestId.current === state.revealRequestId
    ) {
      return;
    }
    reveal();
  }, [state.open, state.revealRequestId, hasRevealTarget]);

  return {
    open: state.open,
    autoFocus: state.autoFocus,
    query: state.query,
    result,
    resultIsStale,
    activeIndex,
    highlightsJson,
    changeQuery,
    selectMatch,
    step,
    openFromHeader,
    close,
  };
}
