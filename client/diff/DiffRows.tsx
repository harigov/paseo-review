import type { ReactElement } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { HighlightToken } from "@getpaseo/highlight";
import type { AnalyzedFile, DetailLevel, DiffLine, Hunk, OutlineEntry, Thread } from "../../shared/types";
import { FILE_LINES_MAX } from "../../shared/rpc";
import { DETAIL_LEVELS } from "../../shared/levels";
import type { DraftComment } from "../review/drafts";
import { Chip, riskColor } from "../ui/chips";
import { EmptyState, ErrorState, Skeleton } from "../ui/states";
import { code as codeByDensity, font, radius, space, surfaces, withAlpha, type DiffDensity } from "../ui/tokens";
import { Markdown } from "../render/Markdown";
import { CONTEXT_PAGE_SIZE, type ContextGapPosition } from "./context";
import { applySpansToTokens, type Span } from "./intraline";
import { changeColor, OutlineView } from "./OutlineView";
import { StructuralDiffView } from "./StructuralDiffView";
import { InlineComposer } from "./InlineComposer";
import { expandTabs, markWhitespace } from "./pairing";
import { formatHunkHeader, type Row, type Side } from "./rows";

type Theme = PluginSurfaceProps["theme"];
type ThemeColors = Theme["colors"];
type Layout = PluginSurfaceProps["layout"];

/** Rail colour for a file's position parity (see `Row.rail`): accent for the "even" file,
 * a neutral tone for the "odd" one — never a risk colour, which would read as added/deleted. */
function railColor(rail: 0 | 1, c: ThemeColors): string {
  return rail === 0 ? c.accent : withAlpha(c.foregroundMuted, 0.5);
}

/** Everything a row renderer needs but can't carry itself (rows are plain data; this is the
 * live state/callback surface `ModuleTab` keeps). Nothing here may be a hook — rows render from
 * inside `FlatList`'s `renderItem`, so `renderStreamRow` must stay a plain function. */
export interface StreamRowContext {
  theme: Theme;
  layout: Layout;
  density: DiffDensity;
  repo: string;
  number: number;
  headSha: string;
  viewer: string | null;
  palette: Record<string, string>;

  getHunk(path: string, hunkIndex: number): Hunk | undefined;
  getTokens(path: string, hunkIndex: number): HighlightToken[][];
  /** Word-level emphasis spans per line, parallel to `getTokens`; `null` for a line that isn't
   * part of a matched del/add pair, is whitespace-only, or changed too much to be worth it. */
  getIntraline(path: string, hunkIndex: number): Array<Span[] | null>;
  getDraft(path: string, draftId: number): DraftComment | undefined;

  /** Row index of the keyboard line cursor, or `null`; drawn with a 2px accent left border. */
  cursorIndex: number | null;
  /** The file currently under keyboard control (from `j`/`k` or scroll tracking); its header
   * gets the same 2px accent left border as the cursor row. */
  currentPath: string | null;

  onToggleViewed(file: AnalyzedFile): void;
  /** "Viewed & next": marks `file` viewed, collapses it, and expands + scrolls to the next
   * not-fully-viewed file in reading order — same flow as the `v` keyboard shortcut. */
  onMarkViewedAndNext(file: AnalyzedFile): void;
  /** Pressing the file header (or `e` on the current file): toggles between "files" and this
   * file's "open" level (see `openFileLevel` in rows.ts). */
  onToggleFileOpen(path: string): void;
  /** The compact F/D/C control: sets this file's level explicitly. */
  onSetFileLevel(path: string, level: DetailLevel): void;
  /** Declarations level: toggles a `decl` row's inline hunk drill-down. */
  onToggleDecl(path: string, index: number): void;
  onOpenMove(path: string): void;
  onToggleOutline(path: string): void;
  onSelectOutlineEntry(path: string, entry: OutlineEntry): void;
  onRevealSinceViewed(path: string): void;
  onSetViewMode(path: string, mode: "text" | "structure"): void;
  viewModeOf(path: string): "text" | "structure";

  onExpandHunk(path: string, hunkIndex: number): void;
  /** Keys of `expandContext` gaps currently being fetched (`${path}:${position}:${hunkIndex}`). */
  contextPending: ReadonlySet<string>;
  onExpandContext(path: string, position: ContextGapPosition, hunkIndex: number, mode: "press" | "all"): void;

  hoverKey: string | null;
  onHoverGutter(key: string | null): void;
  /** Called on hover-out with the key the pressable itself owns; the caller only clears
   * `hoverKey` when it still matches, so a late hover-out from a previous row can't stomp a
   * newer hover-in that already landed on a different row. */
  onHoverGutterOut(key: string): void;
  /** Whole-row hover highlight (web), distinct from the "+" gutter's own hover state so hovering
   * the gutter doesn't clear the row's highlight. */
  hoveredRowKey: string | null;
  onHoverRow(key: string | null): void;
  /** Same late-event guard as `onHoverGutterOut`, for the whole-row hover highlight. */
  onHoverRowOut(key: string): void;
  onOpenComposer(path: string, side: Side, line: number): void;

  isReplyOpen(threadId: string): boolean;
  onToggleReply(threadId: string): void;
  replyBodyOf(threadId: string): string;
  onChangeReplyBody(threadId: string, text: string): void;
  sendingReplyId: string | null;
  onSendReply(thread: Thread, resolve: boolean): void;
  pendingDeleteCommentId: string | null;
  onPressDeleteComment(commentId: string): void;
  onOpenEditComment(path: string, side: Side, line: number, comment: Thread["comments"][number]): void;

  onOpenEditDraft(draft: DraftComment): void;
  onDeleteDraft(draft: DraftComment): void;

  composerBody: string;
  onChangeComposerBody(text: string): void;
  composerBusy: boolean;
  onCancelComposer(): void;
  onAddToReview(): void;
  onCommentNow(): void;
  onSaveComposer(): void;

  onRetryDiff(path: string): void;
}

function renamedLabel(file: AnalyzedFile): string {
  if (file.oldPath && file.oldPath !== file.path) return `${file.oldPath} → ${file.path}`;
  return file.path;
}

function moduleSourceLabel(file: AnalyzedFile): string {
  if (file.moduleSource === "decision") {
    return `decision ${file.moduleConfidence !== null ? file.moduleConfidence.toFixed(2) : ""}`.trim();
  }
  return file.moduleSource;
}

function lineTarget(line: DiffLine): { side: Side; number: number } | null {
  if (line.kind === "context") return line.newNo !== null ? { side: "RIGHT", number: line.newNo } : null;
  if (line.newNo !== null) return { side: "RIGHT", number: line.newNo };
  if (line.oldNo !== null) return { side: "LEFT", number: line.oldNo };
  return null;
}

function codeTextStyle(code: { fontFamily: string; fontSize: number; lineHeight: number }) {
  return { ...code, ...(Platform.OS === "web" ? ({ whiteSpace: "pre" } as unknown as object) : {}) };
}

function renderAddGutter(ctx: StreamRowContext, gutterKey: string, target: { side: Side; number: number } | null, path: string, lineHeight: number) {
  const c = ctx.theme.colors;
  const hovered = ctx.hoverKey === gutterKey;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!target}
      onPress={() => target && ctx.onOpenComposer(path, target.side, target.number)}
      onHoverIn={() => target && ctx.onHoverGutter(gutterKey)}
      onHoverOut={() => ctx.onHoverGutterOut(gutterKey)}
      style={{ width: 18, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontSize: 13, lineHeight, color: hovered ? c.accent : c.foregroundMuted, opacity: target ? (hovered ? 1 : 0.35) : 0 }}>+</Text>
    </Pressable>
  );
}

/** Stronger tint behind intra-line (word-level) emphasis, layered over the row's own 0.18 tint. */
const INTRALINE_ALPHA = 0.32;

function renderLineContent(
  line: DiffLine,
  tokens: HighlightToken[],
  spans: Span[] | null,
  ctx: StreamRowContext,
  codeText: ReturnType<typeof codeTextStyle>,
): ReactElement | null {
  const c = ctx.theme.colors;
  if (line.whitespaceOnly) {
    return (
      <Text selectable style={{ ...codeText, flex: 1, paddingRight: 12, color: c.foregroundMuted, opacity: 0.6 }} numberOfLines={1}>
        {markWhitespace(line.text)}
      </Text>
    );
  }
  if (spans && spans.length > 0) {
    const emphasisColor = line.kind === "del" ? c.statusDanger : line.kind === "add" ? c.statusSuccess : null;
    const baseTokens: HighlightToken[] = tokens.length > 0 ? tokens : [{ text: expandTabs(line.text) || " ", style: null }];
    const pieces = applySpansToTokens(baseTokens, spans);
    return (
      <Text selectable style={{ ...codeText, flex: 1, paddingRight: 12 }} numberOfLines={1}>
        {pieces.map((piece, i) => (
          <Text
            key={i}
            style={{
              color: piece.style ? ctx.palette[piece.style] : c.foreground,
              backgroundColor: piece.emphasized && emphasisColor ? withAlpha(emphasisColor, INTRALINE_ALPHA) : undefined,
            }}
          >
            {piece.text}
          </Text>
        ))}
      </Text>
    );
  }
  const body = tokens.length
    ? tokens.map((token, i) => (
        <Text key={i} style={{ color: token.style ? ctx.palette[token.style] : c.foreground }}>
          {token.text}
        </Text>
      ))
    : expandTabs(line.text) || " ";
  return (
    <Text selectable style={{ ...codeText, flex: 1, paddingRight: 12 }} numberOfLines={1}>
      {body}
    </Text>
  );
}

function renderLineRow(row: Extract<Row, { type: "line" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const hunk = ctx.getHunk(row.path, row.hunkIndex);
  if (!hunk) return null;
  const line = hunk.lines[row.lineIndex];
  const tokens = ctx.getTokens(row.path, row.hunkIndex)[row.lineIndex] ?? [];
  const spans = ctx.getIntraline(row.path, row.hunkIndex)[row.lineIndex] ?? null;
  const code = codeByDensity[ctx.density];
  const codeText = codeTextStyle(code);
  const bg = line.kind === "add" ? c.statusSuccess : line.kind === "del" ? c.statusDanger : null;
  const target = lineTarget(line);
  const rowKey = `row-line-${row.path}-${row.hunkIndex}-${row.lineIndex}`;
  const hovered = ctx.hoveredRowKey === rowKey;
  const isCursor = ctx.cursorIndex === index;
  return (
    <Pressable
      onHoverIn={() => ctx.onHoverRow(rowKey)}
      onHoverOut={() => ctx.onHoverRowOut(rowKey)}
      style={{
        flexDirection: "row",
        minHeight: code.lineHeight,
        opacity: line.moved ? 0.55 : 1,
        backgroundColor: hovered ? c.surface1 : undefined,
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: withAlpha(bg, 0.18) }} /> : null}
      {renderAddGutter(ctx, `line-${row.path}-${row.hunkIndex}-${row.lineIndex}`, target, row.path, code.lineHeight)}
      <Pressable accessibilityRole="button" disabled={!target} onPress={() => target && ctx.onOpenComposer(row.path, target.side, target.number)} style={{ flexDirection: "row" }}>
        <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted }}>{line.oldNo ?? ""}</Text>
        <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted, marginRight: 4 }}>{line.newNo ?? ""}</Text>
      </Pressable>
      <Text style={{ ...code, width: 16, color: bg ?? c.foregroundMuted }}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</Text>
      {line.moved ? <Text style={{ ...code, width: 28, color: c.accent, fontSize: 10 }}>↔ moved</Text> : null}
      {renderLineContent(line, tokens, spans, ctx, codeText)}
    </Pressable>
  );
}

function renderPairCell(path: string, hunkIndex: number, index: number | null, side: "old" | "new", hunk: Hunk, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const code = codeByDensity[ctx.density];
  if (index === null) {
    return <View style={{ flex: 1, minHeight: code.lineHeight, backgroundColor: c.surface1, opacity: 0.5 }} />;
  }
  const line = hunk.lines[index];
  const tokens = ctx.getTokens(path, hunkIndex)[index] ?? [];
  const spans = ctx.getIntraline(path, hunkIndex)[index] ?? null;
  const codeText = codeTextStyle(code);
  const tinted = side === "old" ? line.kind === "del" : line.kind === "add";
  const bg = tinted ? (side === "old" ? c.statusDanger : c.statusSuccess) : null;
  const lineNo = side === "old" ? line.oldNo : line.newNo;
  const marker = side === "old" ? (line.kind === "del" ? "−" : " ") : line.kind === "add" ? "+" : " ";
  const target: { side: Side; number: number } | null = lineNo !== null ? { side: side === "old" ? "LEFT" : "RIGHT", number: lineNo } : null;
  return (
    <View style={{ flex: 1, flexDirection: "row", minHeight: code.lineHeight, opacity: line.moved ? 0.55 : 1 }}>
      {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: withAlpha(bg, 0.18) }} /> : null}
      {renderAddGutter(ctx, `pair-${path}-${hunkIndex}-${index}-${side}`, target, path, code.lineHeight)}
      <Pressable accessibilityRole="button" disabled={!target} onPress={() => target && ctx.onOpenComposer(path, target.side, target.number)} style={{ flexDirection: "row" }}>
        <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted }}>{lineNo ?? ""}</Text>
      </Pressable>
      <Text style={{ ...code, width: 16, color: bg ?? c.foregroundMuted }}>{marker}</Text>
      {line.moved ? <Text style={{ ...code, width: 28, color: c.accent, fontSize: 10 }}>↔ moved</Text> : null}
      {renderLineContent(line, tokens, spans, ctx, codeText)}
    </View>
  );
}

function renderPairRow(row: Extract<Row, { type: "pair" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const hunk = ctx.getHunk(row.path, row.hunkIndex);
  if (!hunk) return null;
  const code = codeByDensity[ctx.density];
  const rowKey = `row-pair-${row.path}-${row.hunkIndex}-${row.oldIndex ?? "x"}-${row.newIndex ?? "x"}`;
  const hovered = ctx.hoveredRowKey === rowKey;
  const isCursor = ctx.cursorIndex === index;
  return (
    <Pressable
      onHoverIn={() => ctx.onHoverRow(rowKey)}
      onHoverOut={() => ctx.onHoverRowOut(rowKey)}
      style={{
        flexDirection: "row",
        minHeight: code.lineHeight,
        backgroundColor: hovered ? c.surface1 : undefined,
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      {renderPairCell(row.path, row.hunkIndex, row.oldIndex, "old", hunk, ctx)}
      <View style={{ width: 1, backgroundColor: c.border }} />
      {renderPairCell(row.path, row.hunkIndex, row.newIndex, "new", hunk, ctx)}
    </Pressable>
  );
}

/** Compact F / D / C control (the per-file equivalent of the module header's segmented level
 * control): selecting a letter sets that file's level explicitly via `setFileLevel`. */
function FileLevelPills({ level, c, onSelect }: { level: DetailLevel; c: ThemeColors; onSelect: (level: DetailLevel) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {DETAIL_LEVELS.map((candidate) => (
        <Pressable
          key={candidate}
          accessibilityRole="button"
          onPress={() => onSelect(candidate)}
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: radius.sm,
            backgroundColor: level === candidate ? c.accent : c.surface2,
          }}
        >
          <Text style={{ ...font.caption, fontWeight: "600", color: level === candidate ? c.accentForeground : c.foregroundMuted }}>
            {candidate === "files" ? "F" : candidate === "declarations" ? "D" : "C"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function renderFileHeader(row: Extract<Row, { type: "fileHeader" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const { file } = row;
  const isCurrentFile = ctx.currentPath === row.path;
  const isOpen = row.level !== "files";
  return (
    <View
      style={{
        backgroundColor: c.surface1,
        borderBottomWidth: 1,
        borderColor: withAlpha(c.border, 0.6),
        borderTopWidth: 2,
        borderTopColor: railColor(row.rail, c),
        flexDirection: "row",
        alignItems: "center",
        padding: space.sm,
        gap: space.sm,
        borderLeftWidth: 2,
        borderLeftColor: isCurrentFile ? c.accent : "transparent",
      }}
    >
      <Pressable accessibilityRole="checkbox" onPress={() => ctx.onToggleViewed(file)}>
        <Icon name={row.viewed === "VIEWED" ? "CheckSquare" : "Square"} size={16} color={row.viewed === "VIEWED" ? c.statusSuccess : c.foregroundMuted} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => ctx.onToggleFileOpen(row.path)} style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
          <Text style={{ ...font.body, fontWeight: "600", color: c.foreground }} numberOfLines={1}>
            {renamedLabel(file)}
          </Text>
          <Text style={{ ...font.caption, color: c.foregroundMuted }}>{file.status}</Text>
          <Text style={{ ...font.caption, color: c.statusSuccess }}>+{file.additions}</Text>
          <Text style={{ ...font.caption, color: c.statusDanger }}>−{file.deletions}</Text>
          {file.risk !== null ? <Chip label={`risk ${file.risk}`} color={riskColor(file.risk, c)} /> : null}
        </View>
        {!isOpen && row.outlineSummary ? <Text style={{ ...font.caption, color: c.foregroundMuted }}>{row.outlineSummary}</Text> : null}
      </Pressable>
      <FileLevelPills level={row.level} c={c} onSelect={(level) => ctx.onSetFileLevel(row.path, level)} />
      {isOpen ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => ctx.onMarkViewedAndNext(file)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: space.xs, paddingVertical: 2 }}
        >
          <Icon name="Check" size={13} color={c.accent} />
          <Text style={{ ...font.caption, color: c.accent }}>Viewed &amp; next</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => ctx.onOpenMove(row.path)} style={{ padding: space.xs }}>
        <Icon name="FolderSymlink" size={14} color={c.foregroundMuted} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => ctx.onToggleFileOpen(row.path)}>
        <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={16} color={c.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function renderFileMeta(row: Extract<Row, { type: "fileMeta" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const { file } = row;
  const mode = ctx.viewModeOf(row.path);
  return (
    <View style={{ padding: space.sm, paddingTop: 0, gap: space.xs, backgroundColor: c.surface1, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{file.effectiveLines} eff. lines</Text>
      {file.movedLines > 0 ? <Chip label={`moved ${file.movedLines}`} color={c.accent} /> : null}
      {file.complexity !== null ? <Chip label={`cx ${file.complexity}`} color={riskColor(file.complexity, c)} /> : null}
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{moduleSourceLabel(file)}</Text>
      {file.noiseReason ? <Text style={{ ...font.caption, color: c.foregroundMuted, fontStyle: "italic" }}>{file.noiseReason}</Text> : null}
      {row.viewed === "DISMISSED" ? (
        <Pressable accessibilityRole="button" onPress={() => ctx.onRevealSinceViewed(row.path)}>
          <Text style={{ ...font.caption, color: row.sinceViewedHighlighted ? c.statusSuccess : c.statusWarning }}>
            {row.sinceViewedHighlighted ? "showing changes since you viewed" : "changed since you viewed"}
            {file.changedSinceViewedProbability !== null
              ? file.changedSinceViewedProbability >= 0.5
                ? ` · substantive ${Math.round(file.changedSinceViewedProbability * 100)}%`
                : " · likely trivial"
              : ""}
          </Text>
        </Pressable>
      ) : null}
      {file.structuralKind && row.level === "code" ? (
        <View style={{ flexDirection: "row", gap: space.xs, marginLeft: "auto" }}>
          {(["text", "structure"] as const).map((candidate) => (
            <Pressable
              key={candidate}
              accessibilityRole="button"
              onPress={() => ctx.onSetViewMode(row.path, candidate)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: radius.pill,
                backgroundColor: mode === candidate ? c.accent : c.surface2,
              }}
            >
              <Text style={{ ...font.caption, color: mode === candidate ? c.accentForeground : c.foregroundMuted }}>
                {candidate === "text" ? "Text" : "Structure"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function renderOutline(row: Extract<Row, { type: "outline" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  return (
    <View style={{ padding: space.sm, paddingTop: 0, gap: space.xs, backgroundColor: c.surface1 }}>
      <Pressable accessibilityRole="button" onPress={() => ctx.onToggleOutline(row.path)} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Icon name={row.expanded ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
        <Text style={{ ...font.small, fontWeight: "600", color: c.foreground }}>Outline</Text>
        {row.summary ? <Text style={{ ...font.caption, color: c.foregroundMuted }}>{row.summary}</Text> : null}
      </Pressable>
      {row.expanded ? <OutlineView entries={row.entries} theme={ctx.theme} onSelect={(entry) => ctx.onSelectOutlineEntry(row.path, entry)} /> : null}
    </View>
  );
}

/** "L12–40", preferring the new range and falling back to the old one — same convention as
 * `OutlineView`'s own label, duplicated here to keep this row renderer self-contained. */
function declRangeLabel(entry: OutlineEntry): string | null {
  const start = entry.newStart ?? entry.oldStart;
  const end = entry.newEnd ?? entry.oldEnd;
  if (start === null || end === null) return null;
  return `L${start}–${end}`;
}

/** Declarations level: one row per changed declaration. Pressing it toggles an inline drill-down
 * of the hunks overlapping its range, rendered directly below by the ordinary hunkHeader/line/
 * pair renderers (`buildFileRows` in rows.ts emits those with decl-prefixed keys). */
function renderDecl(row: Extract<Row, { type: "decl" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const entry = row.entry;
  const isCursor = ctx.cursorIndex === index;
  const range = declRangeLabel(entry);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => ctx.onToggleDecl(row.path, row.index)}
      style={{
        paddingVertical: 6,
        paddingHorizontal: space.sm,
        backgroundColor: c.surface1,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        borderBottomWidth: 1,
        borderColor: withAlpha(c.border, 0.4),
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      <Icon name={row.expanded ? "ChevronDown" : "ChevronRight"} size={12} color={c.foregroundMuted} />
      <Chip label={entry.change} color={changeColor(entry.change, c)} />
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{entry.kind}</Text>
      <Text style={{ ...font.body, fontWeight: "600", color: c.foreground, flex: 1 }} numberOfLines={1}>
        {entry.name}
      </Text>
      {entry.exported ? <Chip label="exported" color={c.accent} /> : null}
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{`+/- ${entry.changedLines}`}</Text>
      {range ? <Text style={{ ...font.caption, color: c.foregroundMuted }}>{range}</Text> : null}
    </Pressable>
  );
}

/** Declarations level, no outline for this file (unsupported language, or too large to parse). */
function renderNoOutline(row: Extract<Row, { type: "noOutline" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  return (
    <View style={{ padding: space.sm, backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <Text style={{ ...font.caption, color: c.foregroundMuted, flex: 1 }}>
        No declaration outline for this file · {row.changedLines} changed lines
      </Text>
      <Pressable accessibilityRole="button" onPress={() => ctx.onSetFileLevel(row.path, "code")}>
        <Text style={{ ...font.caption, color: c.accent }}>Show code</Text>
      </Pressable>
    </View>
  );
}

/** After every file whose level isn't "files": a closing marker plus "Viewed & next" — the
 * natural place to act once a file is finished — followed by visible spacing before the next
 * file's header (the spacing is this row's own bottom padding, so it scrolls with the content). */
function renderFileEnd(row: Extract<Row, { type: "fileEnd" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const { file } = row;
  return (
    <View style={{ padding: space.sm, paddingBottom: space.lg, backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="ArrowDown" size={12} color={c.foregroundMuted} />
      <Text style={{ ...font.caption, color: c.foregroundMuted, flex: 1 }}>
        End of {renamedLabel(file)} · +{file.additions} −{file.deletions}
      </Text>
      <Pressable accessibilityRole="button" onPress={() => ctx.onMarkViewedAndNext(file)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon name="Check" size={12} color={c.accent} />
        <Text style={{ ...font.caption, color: c.accent }}>Viewed &amp; next</Text>
      </Pressable>
    </View>
  );
}

function renderThread(row: Extract<Row, { type: "thread" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const thread = row.thread;
  const target = thread.line ?? thread.originalLine;
  const side = thread.diffSide;
  const replyOpen = ctx.isReplyOpen(thread.id);
  const sending = ctx.sendingReplyId === thread.id;
  const isCursor = ctx.cursorIndex === index;
  return (
    <View
      style={{
        padding: space.sm,
        paddingLeft: space.lg,
        backgroundColor: c.surface1,
        gap: space.xs,
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      <View style={{ flexDirection: "row", gap: space.xs, alignItems: "center" }}>
        <Icon name="MessageCircle" size={12} color={c.foregroundMuted} />
        <Text style={{ ...font.caption, color: c.foregroundMuted }}>
          {thread.isResolved ? "Resolved" : "Open"} thread{thread.isOutdated ? " · outdated" : ""}
        </Text>
      </View>
      {thread.comments.map((comment) => {
        const mine = ctx.viewer !== null && comment.author === ctx.viewer;
        const confirmingDelete = ctx.pendingDeleteCommentId === comment.id;
        return (
          <View key={comment.id} style={{ gap: 2 }}>
            <Text style={{ ...font.small, fontWeight: "600", color: c.foreground }}>{comment.author}</Text>
            <Markdown body={comment.body} theme={ctx.theme} baseUrl={comment.url} />
            {mine ? (
              <View style={{ flexDirection: "row", gap: space.md }}>
                <Pressable accessibilityRole="button" onPress={() => ctx.onOpenEditComment(row.path, side, target ?? 0, comment)}>
                  <Text style={{ ...font.caption, color: c.accent }}>Edit</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => ctx.onPressDeleteComment(comment.id)}>
                  <Text style={{ ...font.caption, color: c.statusDanger }}>{confirmingDelete ? "Confirm delete" : "Delete"}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}
      <View style={{ gap: space.xs }}>
        <Pressable accessibilityRole="button" onPress={() => ctx.onToggleReply(thread.id)}>
          <Text style={{ ...font.caption, color: c.accent }}>{replyOpen ? "Cancel reply" : "Reply"}</Text>
        </Pressable>
        {replyOpen ? (
          <View style={{ gap: space.xs }}>
            <TextInput
              value={ctx.replyBodyOf(thread.id)}
              onChangeText={(value) => ctx.onChangeReplyBody(thread.id, value)}
              placeholder="Reply…"
              multiline
              style={{ minHeight: 50, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: space.xs, fontSize: 12 }}
            />
            <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
              <Pressable accessibilityRole="button" disabled={sending} onPress={() => ctx.onSendReply(thread, false)} style={surfaces(c).buttonQuiet}>
                <Text style={surfaces(c).buttonQuietText}>Reply</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={sending} onPress={() => ctx.onSendReply(thread, true)} style={surfaces(c).button}>
                <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                  <Icon name="Check" size={11} color={c.accentForeground} />
                  <Text style={surfaces(c).buttonText}>Reply &amp; resolve</Text>
                </View>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function renderDraft(row: Extract<Row, { type: "draft" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const draft = ctx.getDraft(row.path, row.draftId);
  if (!draft) return null;
  return (
    <View style={{ padding: space.sm, paddingLeft: space.lg, backgroundColor: c.surface1, gap: space.xs }}>
      <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.accent, alignSelf: "flex-start" }}>
        <Text style={{ ...font.caption, color: c.accentForeground, fontWeight: "600" }}>Draft</Text>
      </View>
      <Text style={{ ...font.bodyLg, color: c.foreground }}>{draft.body}</Text>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <Pressable accessibilityRole="button" onPress={() => ctx.onOpenEditDraft(draft)}>
          <Text style={{ ...font.caption, color: c.accent }}>Edit</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => ctx.onDeleteDraft(draft)}>
          <Text style={{ ...font.caption, color: c.statusDanger }}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

function renderFinding(row: Extract<Row, { type: "finding" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const isCursor = ctx.cursorIndex === index;
  return (
    <View
      style={{
        padding: 6,
        paddingLeft: space.lg,
        backgroundColor: c.surface1,
        flexDirection: "row",
        gap: space.xs,
        alignItems: "center",
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      <Text style={{ ...font.caption, color: c.statusDanger }}>
        ✗ {row.finding.validatorTitle} {Math.round(row.finding.probability * 100)}%
      </Text>
    </View>
  );
}

function renderComposer(row: Extract<Row, { type: "composer" }>, ctx: StreamRowContext): ReactElement | null {
  // Identifies this specific composer target (distinct from the row's own FlatList `key`, which
  // is only `${path}:composer` — the same list key is reused when the composer moves to a
  // different line/mode on the same path — so `InlineComposer` can tell "freshly opened" apart
  // from "re-rendered for an unrelated reason" and steal focus only on the former.
  const targetKey = `${row.path}:${row.side}:${row.line}:${row.mode}:${row.mode === "editDraft" ? row.draftId : row.mode === "editComment" ? row.commentId : ""}`;
  return (
    <InlineComposer
      theme={ctx.theme}
      mode={row.mode}
      body={ctx.composerBody}
      onChangeBody={ctx.onChangeComposerBody}
      busy={ctx.composerBusy}
      onCancel={ctx.onCancelComposer}
      onAddToReview={ctx.onAddToReview}
      onCommentNow={ctx.onCommentNow}
      onSave={ctx.onSaveComposer}
      targetKey={targetKey}
    />
  );
}

function renderHunkHeader(row: Extract<Row, { type: "hunkHeader" }>, index: number, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  const code = codeByDensity[ctx.density];
  const label = formatHunkHeader(row.context, row.newStart, row.newEnd);
  const isCursor = ctx.cursorIndex === index;
  return (
    <View
      style={{
        minHeight: 26,
        backgroundColor: c.surface1,
        justifyContent: "center",
        borderLeftWidth: 2,
        borderLeftColor: isCursor ? c.accent : "transparent",
      }}
    >
      <Text style={{ ...codeTextStyle(code), fontSize: 11, color: c.foregroundMuted, paddingHorizontal: space.sm }}>{label}</Text>
    </View>
  );
}

function renderCollapsed(row: Extract<Row, { type: "collapsed" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => ctx.onExpandHunk(row.path, row.hunkIndex)}
      style={{ minHeight: 26, backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm }}
    >
      <Icon name={row.kind === "moved" ? "ArrowLeftRight" : "Eraser"} size={12} color={c.foregroundMuted} />
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>
        {row.kind === "moved" ? `Moved block (${row.count} lines) — show` : `Whitespace-only change (${row.count} lines) — show`}
      </Text>
    </Pressable>
  );
}

function renderExpandContext(row: Extract<Row, { type: "expandContext" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  if (row.unsafe) {
    return (
      <View style={{ minHeight: 24, backgroundColor: c.surface1, justifyContent: "center", paddingHorizontal: space.sm }}>
        <Text style={{ ...font.caption, color: c.foregroundMuted }}>{row.count} line{row.count === 1 ? "" : "s"} not shown (diff truncated)</Text>
      </View>
    );
  }
  const busyKey = `${row.path}:${row.position}:${row.hunkIndex}`;
  const busy = ctx.contextPending.has(busyKey);
  const nextPress = Math.min(CONTEXT_PAGE_SIZE, row.count);
  const showExpandAll = row.totalCount <= FILE_LINES_MAX && row.count > nextPress;
  return (
    <View style={{ minHeight: 24, backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.sm }}>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => ctx.onExpandContext(row.path, row.position, row.hunkIndex, "press")}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs, opacity: busy ? 0.6 : 1 }}
      >
        <Icon name="ChevronsUpDown" size={12} color={c.foregroundMuted} />
        <Text style={{ ...font.caption, color: c.foregroundMuted }}>{busy ? "Expanding…" : `Expand ${nextPress} lines`}</Text>
      </Pressable>
      {showExpandAll ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => ctx.onExpandContext(row.path, row.position, row.hunkIndex, "all")}>
          <Text style={{ ...font.caption, color: c.accent }}>Expand all {row.count}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function renderTruncated(ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  return (
    <View style={{ padding: space.sm, backgroundColor: c.surface2 }}>
      <Text style={{ ...font.caption, color: c.statusWarning }}>Diff truncated — file is too large to show in full.</Text>
    </View>
  );
}

function renderStructural(row: Extract<Row, { type: "structural" }>, ctx: StreamRowContext): ReactElement | null {
  return (
    <View style={{ padding: space.sm }}>
      <StructuralDiffView
        repo={ctx.repo}
        number={ctx.number}
        path={row.path}
        headSha={ctx.headSha}
        theme={ctx.theme}
        onShowText={() => ctx.onSetViewMode(row.path, "text")}
      />
    </View>
  );
}

function renderLoading(ctx: StreamRowContext): ReactElement | null {
  return <Skeleton theme={ctx.theme} rows={3} />;
}

function renderErrorRow(row: Extract<Row, { type: "error" }>, ctx: StreamRowContext): ReactElement | null {
  const c = ctx.theme.colors;
  if (row.tone === "muted") {
    return (
      <View style={{ padding: space.md }}>
        <Text style={{ ...font.body, color: c.foregroundMuted }}>{row.message}</Text>
      </View>
    );
  }
  return <ErrorState theme={ctx.theme} message={row.message} onRetry={() => ctx.onRetryDiff(row.path)} />;
}

function renderEmpty(row: Extract<Row, { type: "empty" }>, ctx: StreamRowContext): ReactElement | null {
  return (
    <EmptyState
      theme={ctx.theme}
      icon="Inbox"
      title="Nothing to review here"
      hint={row.reason === "since_last_review" ? "Files changed since your last review are hidden by the current filter." : undefined}
    />
  );
}

function renderRowContent(row: Row, index: number, ctx: StreamRowContext): ReactElement | null {
  switch (row.type) {
    case "fileHeader":
      return renderFileHeader(row, ctx);
    case "fileMeta":
      return renderFileMeta(row, ctx);
    case "outline":
      return renderOutline(row, ctx);
    case "decl":
      return renderDecl(row, index, ctx);
    case "noOutline":
      return renderNoOutline(row, ctx);
    case "fileEnd":
      return renderFileEnd(row, ctx);
    case "structural":
      return renderStructural(row, ctx);
    case "truncated":
      return renderTruncated(ctx);
    case "hunkHeader":
      return renderHunkHeader(row, index, ctx);
    case "collapsed":
      return renderCollapsed(row, ctx);
    case "line":
      return renderLineRow(row, index, ctx);
    case "pair":
      return renderPairRow(row, index, ctx);
    case "thread":
      return renderThread(row, index, ctx);
    case "finding":
      return renderFinding(row, index, ctx);
    case "draft":
      return renderDraft(row, ctx);
    case "composer":
      return renderComposer(row, ctx);
    case "expandContext":
      return renderExpandContext(row, ctx);
    case "loading":
      return renderLoading(ctx);
    case "error":
      return renderErrorRow(row, ctx);
    case "empty":
      return renderEmpty(row, ctx);
    default:
      return null;
  }
}

/** Renders one row of the diff stream. Call from `FlatList`'s `renderItem` — this is a plain
 * function (not a hook-using component) so it can safely branch on `row.type`. `index` is the
 * row's position in the stream (needed for the keyboard cursor's accent border). Every row
 * belonging to a file (i.e. every type but `empty`) is wrapped in its file's 3px rail border —
 * see `Row.rail` in rows.ts — so a file boundary is visible down the whole stream, not just on
 * the sticky header (which also gets a top edge in the same colour; see `renderFileHeader`). */
export function renderStreamRow(row: Row, index: number, ctx: StreamRowContext): ReactElement | null {
  const content = renderRowContent(row, index, ctx);
  if (row.type === "empty" || content === null) return content;
  return <View style={{ borderLeftWidth: 3, borderLeftColor: railColor(row.rail, ctx.theme.colors) }}>{content}</View>;
}
