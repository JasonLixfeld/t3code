import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import {
  EMPTY_REVIEW_FIND_RESULT,
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
    readonly contentsSearchOpen: boolean;
    readonly focusRequestId: number;
    readonly query: string;
    readonly chosenMatch: ReviewFindMatch | null;
    readonly revealRequestId: number;
  }>({
    open: false,
    contentsSearchOpen: false,
    focusRequestId: 0,
    query: "",
    chosenMatch: null,
    revealRequestId: 0,
  });
  const searchedQuery = useDeferredValue(state.query);
  const searching = state.open || state.contentsSearchOpen;
  const result = useMemo(
    () => (searching ? findInReviewRows(input.rows, searchedQuery) : EMPTY_REVIEW_FIND_RESULT),
    [searching, input.rows, searchedQuery],
  );
  const resultIsStale = searchedQuery !== state.query;
  const activeIndex = resolveReviewFindActiveIndex(result, state.chosenMatch);
  const revealTarget = state.chosenMatch ?? (resultIsStale ? undefined : result.matchAt(0));
  const highlightsJson = useMemo(
    () => (state.open ? reviewFindHighlightsJson(result, activeIndex) : ""),
    [state.open, result, activeIndex],
  );

  const selectMatch = (match: ReviewFindMatch) =>
    setState((current) => ({
      ...current,
      open: true,
      focusRequestId: current.open ? current.focusRequestId : 0,
      chosenMatch: match,
      revealRequestId: current.revealRequestId + 1,
    }));
  const changeQuery = (query: string) =>
    setState((current) => ({
      ...current,
      open: true,
      focusRequestId: current.open ? current.focusRequestId : 0,
      query,
      chosenMatch: null,
      revealRequestId: current.revealRequestId + 1,
    }));
  const step = (direction: 1 | -1) => {
    if (resultIsStale || activeIndex === null) return;
    const match = result.matchAt(stepReviewFindIndex(activeIndex, direction, result.matchCount));
    if (match) selectMatch(match);
  };
  const openFromHeader = () =>
    setState((current) => ({
      ...current,
      open: true,
      focusRequestId: current.focusRequestId + 1,
    }));
  const setContentsSearchOpen = (contentsSearchOpen: boolean) =>
    setState((current) => ({ ...current, contentsSearchOpen }));
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
    focusRequestId: state.focusRequestId,
    query: state.query,
    result,
    resultIsStale,
    activeIndex,
    highlightsJson,
    changeQuery,
    selectMatch,
    step,
    openFromHeader,
    setContentsSearchOpen,
    close,
  };
}
