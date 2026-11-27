import { T, useGT } from "gt-react-native";
import { useEffect, useRef } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ContentBand } from "../../components/ui/ContentBand";
import { IconButton } from "../../components/ui/IconButton";
import { SearchField } from "../../components/ui/SearchField";
import type { ReviewFindResult } from "./reviewFind";

export function ReviewFindPartialHint() {
  return (
    <Text className="text-xs text-foreground-muted">
      <T>Searches loaded changes only</T>
    </Text>
  );
}

export function ReviewFindBar(props: {
  readonly query: string;
  readonly result: ReviewFindResult;
  readonly activeIndex: number | null;
  readonly focusRequestId: number;
  readonly resultIsStale: boolean;
  readonly partial: boolean;
  readonly onChangeQuery: (query: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const inputRef = useRef<TextInputInstance>(null);
  const total = props.result.matchCount;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the native input on each header Find press, including while it is already shown
  useEffect(() => {
    if (props.focusRequestId > 0) inputRef.current?.focus();
  }, [props.focusRequestId]);
  const counter =
    props.query.length === 0
      ? null
      : total === 0 || props.activeIndex === null
        ? gt("No results", { $context: "find in diff counter" })
        : gt("{current} of {total}", {
            current: props.activeIndex + 1,
            total,
          });
  return (
    <ContentBand>
      <View className="flex-row items-center gap-1">
        <SearchField
          inputRef={inputRef}
          autoFocus={false}
          accessibilityLabel={gt("Find in diff")}
          clearAccessibilityLabel={gt("Clear search")}
          placeholder={gt("Find in diff")}
          value={props.query}
          onChangeText={props.onChangeQuery}
          onSubmitEditing={() => props.onStep(1)}
        />
        {counter === null ? null : (
          <Text accessibilityLiveRegion="polite" className="px-1 text-xs text-foreground-muted">
            {counter}
          </Text>
        )}
        <IconButton
          accessibilityLabel={gt("Previous match")}
          icon="chevron.up"
          disabled={total === 0 || props.resultIsStale}
          onPress={() => props.onStep(-1)}
        />
        <IconButton
          accessibilityLabel={gt("Next match")}
          icon="chevron.down"
          disabled={total === 0 || props.resultIsStale}
          onPress={() => props.onStep(1)}
        />
        <IconButton accessibilityLabel={gt("Close find")} icon="xmark" onPress={props.onClose} />
      </View>
      {props.partial ? <ReviewFindPartialHint /> : null}
    </ContentBand>
  );
}
