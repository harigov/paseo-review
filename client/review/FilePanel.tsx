import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { FlatList as NativeFlatList } from "react-native";
import { FlatList, Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { AnalyzedFile, DetailLevel, ViewedState } from "../../shared/types";
import { Dot, riskColor } from "../ui/chips";
import { EmptyState } from "../ui/states";
import { font, radius, space, surfaces, withAlpha } from "../ui/tokens";
import { filterFilePanelItems, findFilePanelIndex, splitPath, statusLetter, statusTone, truncateHead, type StatusTone } from "./file-panel-model";

// File selector for the module tab: the module's visible files in reading order, the one in view
// highlighted. Presentational only — ModuleTab owns data, scrolling and focus. Owned by
// workstream C; see docs/plan-round4.md §3.

export interface FilePanelItem {
  path: string;
  oldPath: string | null;
  status: AnalyzedFile["status"];
  additions: number;
  deletions: number;
  /** 1–5 from the decision model; null when unavailable. */
  risk: number | null;
  /** Resolved (after optimistic overrides). */
  viewed: ViewedState;
  /** The file's effective review depth ("files" = collapsed in the stream). */
  level: DetailLevel;
  /** Unresolved review threads on this file. */
  threadCount: number;
  /** Pending draft comments on this file. */
  draftCount: number;
  /** Failing/uncertain, undismissed validator findings on this file. */
  findingCount: number;
}

export interface FilePanelProps {
  theme: PluginSurfaceProps["theme"];
  /** Already in reading order and filtered exactly like the stream. */
  items: FilePanelItem[];
  /** The file currently in view in the stream (highlighted, kept scrolled into view). */
  currentPath: string | null;
  onSelect(path: string): void;
  /** Wide layouts: collapse the panel. Omit to hide the control (e.g. inside the modal). */
  onCollapse?(): void;
}

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

/** Fixed row height: lets `getItemLayout` make `scrollToIndex` exact (no `onScrollToIndexFailed`
 * dance needed) and keeps the list cheap to virtualize over hundreds of files. */
const ROW_HEIGHT = 58;
/** Above this many files, a filter box earns its keep. */
const FILTER_THRESHOLD = 20;
/** Rough character budget for the muted directory line once the status badge, name and the
 * right-hand badges/counters have taken their share of the 320px column; `numberOfLines={1}`
 * backs this up for anything narrower than that estimate. */
const DIR_MAX_CHARS = 42;

function toneColor(tone: StatusTone, c: ThemeColors): string {
  switch (tone) {
    case "success":
      return c.statusSuccess;
    case "danger":
      return c.statusDanger;
    case "accent":
      return c.accent;
    case "muted":
    default:
      return c.foregroundMuted;
  }
}

function fileAccessibilityLabel(item: FilePanelItem, base: string): string {
  const parts = [base, item.status, `${item.additions} additions`, `${item.deletions} deletions`];
  if (item.status === "renamed" && item.oldPath) parts.push(`renamed from ${item.oldPath}`);
  if (item.viewed === "VIEWED") parts.push("viewed");
  return parts.join(", ");
}

function CountBadge({ icon, count, c }: { icon: string; count: number; c: ThemeColors }) {
  if (count <= 0) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <Icon name={icon} size={11} color={c.foregroundMuted} />
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{count}</Text>
    </View>
  );
}

function FileRow({
  item,
  isCurrent,
  isHovered,
  theme,
  onPress,
  onHoverIn,
  onHoverOut,
}: {
  item: FilePanelItem;
  isCurrent: boolean;
  isHovered: boolean;
  theme: PluginSurfaceProps["theme"];
  onPress(): void;
  onHoverIn(): void;
  onHoverOut(): void;
}) {
  const c = theme.colors;
  const { dir, base } = splitPath(item.path);
  const viewed = item.viewed === "VIEWED";
  const background = isCurrent ? c.surface2 : isHovered ? c.surface1 : "transparent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={fileAccessibilityLabel(item, base)}
      onPress={onPress}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      style={{
        height: ROW_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingHorizontal: space.sm,
        backgroundColor: background,
        borderLeftWidth: 2,
        borderLeftColor: isCurrent ? c.accent : "transparent",
        opacity: viewed ? 0.6 : 1,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: radius.sm,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(toneColor(statusTone(item.status), c), 0.15),
        }}
      >
        <Text style={{ ...font.caption, fontWeight: "700", color: toneColor(statusTone(item.status), c) }}>{statusLetter(item.status)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...font.body, color: c.foreground }} numberOfLines={1}>
          {base}
        </Text>
        {dir ? (
          <Text style={{ ...font.caption, color: c.foregroundMuted }} numberOfLines={1}>
            {truncateHead(dir, DIR_MAX_CHARS)}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 3 }}>
          <Text style={{ ...font.small, color: c.statusSuccess }}>+{item.additions}</Text>
          <Text style={{ ...font.small, color: c.statusDanger }}>−{item.deletions}</Text>
        </View>
        {item.risk !== null ? <Dot color={riskColor(item.risk, c)} size={7} /> : null}
        <CountBadge icon="MessageSquare" count={item.threadCount} c={c} />
        <CountBadge icon="FilePen" count={item.draftCount} c={c} />
        <CountBadge icon="TriangleAlert" count={item.findingCount} c={c} />
        {viewed ? <Icon name="Check" size={13} color={c.statusSuccess} /> : null}
      </View>
    </Pressable>
  );
}

/** Shared list body for both the column and the modal. `showCollapse` only matters for the
 * header's collapse button (the modal never shows one, even if a caller forwarded `onCollapse`). */
function FilePanelBody({ theme, items, currentPath, onSelect, onCollapse, showCollapse }: FilePanelProps & { showCollapse: boolean }) {
  const c = theme.colors;
  const s = surfaces(c);
  const [filterText, setFilterText] = useState("");
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const listRef = useRef<NativeFlatList<FilePanelItem> | null>(null);
  const viewableRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: -1 });

  const filtered = useMemo(() => filterFilePanelItems(items, filterText), [items, filterText]);

  // Scrolls the current file into view only when it isn't already visible, so switching files in
  // the stream doesn't fight a reviewer who has scrolled this panel somewhere else on their own.
  useEffect(() => {
    const index = findFilePanelIndex(filtered, currentPath);
    if (index === -1) return;
    const range = viewableRangeRef.current;
    if (index >= range.min && index <= range.max) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5 });
  }, [currentPath, filtered]);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null }> }) => {
    const indices = info.viewableItems.map((v) => v.index).filter((i): i is number => i !== null);
    viewableRangeRef.current = indices.length > 0 ? { min: Math.min(...indices), max: Math.max(...indices) } : { min: 0, max: -1 };
  }).current;

  const renderItem = useCallback(
    ({ item }: { item: FilePanelItem }) => (
      <FileRow
        item={item}
        isCurrent={item.path === currentPath}
        isHovered={item.path === hoveredPath}
        theme={theme}
        onPress={() => onSelect(item.path)}
        onHoverIn={() => setHoveredPath(item.path)}
        onHoverOut={() => setHoveredPath((prev) => (prev === item.path ? null : prev))}
      />
    ),
    [currentPath, hoveredPath, theme, onSelect],
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderBottomWidth: 1, borderColor: withAlpha(c.border, 0.6) }}>
        <Text style={{ ...font.title, color: c.foreground, flex: 1 }}>
          Files <Text style={{ ...font.title, fontWeight: "400", color: c.foregroundMuted }}>({items.length})</Text>
        </Text>
        {showCollapse && onCollapse ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Collapse file panel" onPress={onCollapse} style={{ padding: 2 }}>
            <Icon name="PanelLeftClose" size={16} color={c.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
      {items.length > FILTER_THRESHOLD ? (
        <View style={{ padding: space.sm, paddingBottom: 0 }}>
          <TextInput
            value={filterText}
            onChangeText={setFilterText}
            placeholder="Filter files"
            placeholderTextColor={c.foregroundMuted}
            style={{ ...s.input, ...font.small }}
          />
        </View>
      ) : null}
      {filtered.length === 0 ? (
        <EmptyState theme={theme} icon="Filter" title="No files match" hint={filterText.trim() ? `No files match "${filterText.trim()}".` : "No files to show."} />
      ) : (
        <FlatList
          ref={listRef}
          data={filtered}
          keyExtractor={(item) => item.path}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          initialNumToRender={30}
          windowSize={7}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
        />
      )}
    </View>
  );
}

/** Fills its parent (ModuleTab gives it a 320 px column on wide layouts). */
export function FilePanel(props: FilePanelProps) {
  return <FilePanelBody {...props} showCollapse={true} />;
}

/** Compact layouts: the same list in a modal, opened from a "Files" button in the module header. */
export function FilePanelModal(props: FilePanelProps & { open: boolean; onOpenChange(open: boolean): void }) {
  const { open, onOpenChange, onSelect, onCollapse: _onCollapse, ...rest } = props;
  return (
    <Modal title="Files" open={open} onOpenChange={onOpenChange}>
      <Modal.Content scrollable={false} style={{ flex: 1, minHeight: 360 }}>
        <FilePanelBody
          {...rest}
          onSelect={(path) => {
            onSelect(path);
            onOpenChange(false);
          }}
          showCollapse={false}
        />
      </Modal.Content>
    </Modal>
  );
}
