import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { splitSearchText } from "@t3tools/shared/paletteSearch";
import { LegendList } from "@legendapp/list/react-native";
import { useGT } from "gt-react-native";
import { type Ref, use, useImperativeHandle, useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { PaneListItem } from "../../components/ui/PaneListItem";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SearchField } from "../../components/ui/SearchField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SheetPane } from "../../components/ui/SheetPane";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import { ReviewFindPartialHint } from "./ReviewFindBar";
import type { ReviewFindFile, ReviewFindLine, ReviewFindResult } from "./reviewFind";
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";

export interface ReviewNavigatorFile {
  readonly id: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ReviewFileNavigatorHandle {
  readonly setVisibleFile: (fileId: string | null) => void;
}

export interface ReviewFileNavigatorFind {
  readonly query: string;
  readonly result: ReviewFindResult;
  readonly activeIndex: number | null;
  readonly partial: boolean;
  readonly onChangeQuery: (query: string) => void;
  readonly onSelectMatch: (index: number) => void;
}

type SearchMode = "name" | "contents";

const LINE_MARKERS: Record<ReviewFindLine["change"], string> = {
  add: "+",
  delete: "−",
  context: " ",
};

const ReviewFileNavigatorRow = function ReviewFileNavigatorRow(props: {
  readonly file: ReviewNavigatorFile;
  readonly selected: boolean;
  readonly onSelectFile: (fileId: string | null) => void;
}) {
  const { file, selected, onSelectFile } = props;
  const handlePress = () => {
    onSelectFile(selected ? null : file.id);
  };

  return (
    <PaneListItem selected={selected} onPress={handlePress}>
      <Text
        className={
          selected
            ? "text-xs font-t3-bold text-foreground"
            : "text-xs font-t3-medium text-foreground-secondary"
        }
        numberOfLines={2}
      >
        {file.path}
      </Text>
      <View className="mt-1 flex-row gap-2">
        <Text className="text-2xs font-t3-bold text-adaptive-emerald-700-300">
          +{formatDiffCount(file.additions)}
        </Text>
        <Text className="text-2xs font-t3-bold text-adaptive-rose-700-300">
          -{formatDiffCount(file.deletions)}
        </Text>
      </View>
    </PaneListItem>
  );
};

function ReviewFindFileResult(props: {
  readonly file: ReviewFindFile;
  readonly path: string;
  readonly activeIndex: number | null;
  readonly onSelectMatch: (index: number) => void;
}) {
  const gt = useGT();
  const { file, activeIndex } = props;
  const hiddenLineCount = file.lineCount - file.previewLines.length;
  return (
    <View className="pb-2">
      <PaneListItem selected={false} onPress={() => props.onSelectMatch(file.firstMatchIndex)}>
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-xs font-t3-bold text-foreground" numberOfLines={2}>
            {props.path}
          </Text>
          <Text className="text-2xs font-t3-bold text-foreground-muted">{file.matchCount}</Text>
        </View>
      </PaneListItem>
      {file.previewLines.map((line) => (
        <PaneListItem
          key={line.rowId}
          selected={
            activeIndex !== null &&
            activeIndex >= line.firstMatchIndex &&
            activeIndex < line.firstMatchIndex + line.matchCount
          }
          onPress={() => props.onSelectMatch(line.firstMatchIndex)}
        >
          <View className="flex-row gap-1.5">
            <Text className="w-9 text-right font-mono text-2xs text-foreground-muted">
              {line.lineNumber ?? ""}
            </Text>
            <Text
              className={cn(
                "w-2 font-mono text-2xs",
                line.change === "add" && "text-adaptive-emerald-700-300",
                line.change === "delete" && "text-adaptive-rose-700-300",
              )}
            >
              {LINE_MARKERS[line.change]}
            </Text>
            <Text className="min-w-0 flex-1 font-mono text-2xs text-foreground" numberOfLines={1}>
              {splitSearchText(line.text, line.ranges).map((part) => (
                <Text
                  key={part.start}
                  className={part.highlighted ? "bg-warning font-t3-bold" : undefined}
                >
                  {part.text}
                </Text>
              ))}
            </Text>
          </View>
        </PaneListItem>
      ))}
      {hiddenLineCount > 0 ? (
        <Text className="ps-14 pt-1 text-2xs text-foreground-muted">
          {gt("{count, plural, one {{count} more line} other {{count} more lines}}", {
            count: hiddenLineCount,
          })}
        </Text>
      ) : null}
    </View>
  );
}

interface ReviewFileNavigatorProps {
  readonly files: ReadonlyArray<ReviewNavigatorFile>;
  readonly sectionId: string | null;
  readonly onSelectFile: (fileId: string | null) => void;
  readonly find: ReviewFileNavigatorFind;
  readonly ref?: Ref<ReviewFileNavigatorHandle>;
}

export function ReviewFileNavigator({
  files,
  sectionId,
  onSelectFile,
  find,
  ref,
}: ReviewFileNavigatorProps) {
  const gt = useGT();
  const closeInspectorSheet = use(InspectorSheetContext);
  const barOverlap = useBarOverlap();
  const searchInputRef = useRef<TextInputInstance>(null);
  const [mode, setMode] = useState<SearchMode>("name");
  const [nameQuery, setNameQuery] = useState("");
  const [fileSelection, setFileSelection] = useState<{
    readonly sectionId: string | null;
    readonly fileId: string | null;
  }>({ sectionId: null, fileId: null });
  const availableFileIds = files.map((file) => file.id);
  const selectedFileId = resolveSelectedReviewFileId({
    selection: fileSelection,
    sectionId,
    availableFileIds,
  });

  useImperativeHandle(
    ref,
    () => ({
      setVisibleFile: (fileId) => {
        if (fileId !== null && !availableFileIds.includes(fileId)) {
          return;
        }
        setFileSelection((current) => {
          if (current.sectionId === sectionId && current.fileId === fileId) {
            return current;
          }
          return { sectionId, fileId };
        });
      },
    }),
    [availableFileIds, sectionId],
  );

  const afterSheetCloses = (run: () => void) =>
    closeInspectorSheet ? closeInspectorSheet(run) : run();
  const handleSelectFile = (fileId: string | null) => {
    setFileSelection({ sectionId, fileId });
    afterSheetCloses(() => onSelectFile(fileId));
  };
  const handleSelectMatch = (index: number) => afterSheetCloses(() => find.onSelectMatch(index));
  const handleChangeMode = (next: SearchMode) => {
    if (next === mode) return;
    if (next === "contents") {
      find.onChangeQuery(nameQuery);
      setNameQuery("");
    } else {
      setNameQuery(find.query);
    }
    setMode(next);
  };

  const foldedNameQuery = nameQuery.toLowerCase();
  const shownFiles =
    foldedNameQuery.length === 0
      ? files
      : files.filter((file) => file.path.toLowerCase().includes(foldedNameQuery));
  const pathById = new Map(files.map((file) => [file.id, file.path]));
  const query = mode === "contents" ? find.query : nameQuery;
  const emptyMessage =
    mode === "name"
      ? shownFiles.length === 0
        ? gt("No files match.")
        : null
      : find.query.length === 0
        ? gt("Type to search the changed lines.")
        : find.result.files.length === 0
          ? gt("No changed lines match.")
          : null;

  return (
    <SheetPane>
      <AppBar
        title={gt("Changed files")}
        subtitle={gt("{count, plural, one {{count} file} other {{count} files}}", {
          count: files.length,
        })}
        hideBottomBorder
      />
      <ScreenContent insetHorizontal>
        <View className="gap-2 px-2" style={{ paddingTop: barOverlap + 8 }}>
          <SearchField
            inputRef={searchInputRef}
            autoFocus={false}
            accessibilityLabel={
              mode === "contents" ? gt("Search changed lines") : gt("Filter files by name")
            }
            clearAccessibilityLabel={gt("Clear search")}
            placeholder={
              mode === "contents" ? gt("Search changed lines") : gt("Filter by file name")
            }
            value={query}
            onChangeText={mode === "contents" ? find.onChangeQuery : setNameQuery}
          />
          <SegmentedControl
            size="compact"
            options={[
              { value: "name", label: gt("Name", { $context: "search files by name" }) },
              {
                value: "contents",
                label: gt("Contents", { $context: "search files by their changed lines" }),
              },
            ]}
            selected={mode}
            onSelect={handleChangeMode}
          />
          {mode === "contents" && find.partial ? <ReviewFindPartialHint /> : null}
          {emptyMessage === null ? null : (
            <Text accessibilityLiveRegion="polite" className="py-2 text-xs text-foreground-muted">
              {emptyMessage}
            </Text>
          )}
        </View>
        {mode === "name" ? (
          <LegendList
            renderScrollComponent={NativeScrollView}
            data={shownFiles}
            // Rows keep their callback until extraData changes; it reads collapsed files.
            extraData={[selectedFileId, handleSelectFile]}
            keyExtractor={(file) => file.id}
            estimatedItemSize={64}
            recycleItems
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}
            renderItem={({ item }) => (
              <ReviewFileNavigatorRow
                file={item}
                selected={selectedFileId === item.id}
                onSelectFile={handleSelectFile}
              />
            )}
          />
        ) : (
          <LegendList
            renderScrollComponent={NativeScrollView}
            data={find.result.files}
            extraData={[find.activeIndex, handleSelectMatch]}
            keyExtractor={(file) => file.fileId}
            estimatedItemSize={160}
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}
            renderItem={({ item }) => (
              <ReviewFindFileResult
                file={item}
                path={pathById.get(item.fileId) ?? item.fileId}
                activeIndex={find.activeIndex}
                onSelectMatch={handleSelectMatch}
              />
            )}
          />
        )}
      </ScreenContent>
    </SheetPane>
  );
}
