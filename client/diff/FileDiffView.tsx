import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { highlightCode, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import { fileDiffRpc } from "../../shared/rpc";
import type { DiffLine, FileDiff, Hunk, Thread, ValidatorFinding } from "../../shared/types";
import { addDraft, type DraftComment } from "../review/drafts";
import { pairHunkLines } from "./pairing";

export interface FileDiffFinding extends ValidatorFinding {
  validatorId: string;
  validatorTitle: string;
}

type Side = "LEFT" | "RIGHT";

type Row =
  | { type: "truncated" }
  | { type: "hunkHeader"; hunkIndex: number }
  | { type: "collapsedMoved"; hunkIndex: number; count: number }
  | { type: "collapsedWhitespace"; hunkIndex: number; count: number }
  | { type: "line"; hunkIndex: number; lineIndex: number }
  | { type: "pair"; hunkIndex: number; oldIndex: number | null; newIndex: number | null }
  | { type: "thread"; thread: Thread }
  | { type: "finding"; finding: FileDiffFinding };

const LINE_HEIGHT = 21;
const code = { fontFamily: "monospace", fontSize: 12, lineHeight: LINE_HEIGHT } as const;

/** Parses `#rgb`/`#rrggbb`; returns null (rather than guessing) when the format is unknown. */
function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const full = match[1].length === 3 ? match[1].split("").map((ch) => ch + ch).join("") : match[1];
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Highlights one hunk's old- and new-side text in as few highlightCode calls as possible.
 * Context lines belong to *both* reconstructions (they're identical in the old and new file),
 * so both the old (context+deletions) and new (context+additions) sequences are highlighted in
 * hunk order, and the new-side result wins for lines that appear on both sides — that keeps
 * multi-line tokens (block comments, template literals, JSX) correctly continued across a
 * context/addition boundary instead of losing their preceding context.
 */
function highlightHunk(hunk: Hunk, path: string): HighlightToken[][] {
  const result: HighlightToken[][] = hunk.lines.map(() => []);
  function highlightGroup(indices: number[]) {
    if (indices.length === 0) return;
    const text = indices.map((index) => hunk.lines[index].text).join("\n");
    const tokens = highlightCode(text, path);
    indices.forEach((index, offset) => {
      result[index] = tokens[offset] ?? [];
    });
  }
  const oldIndices: number[] = [];
  const newIndices: number[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.oldNo !== null) oldIndices.push(index);
    if (line.newNo !== null) newIndices.push(index);
  });
  highlightGroup(oldIndices);
  highlightGroup(newIndices);
  return result;
}

function rowHeight(row: Row): number {
  switch (row.type) {
    case "truncated":
      return 32;
    case "hunkHeader":
    case "collapsedMoved":
    case "collapsedWhitespace":
      return 26;
    case "line":
    case "pair":
      return LINE_HEIGHT;
    case "thread":
      return 30 + row.thread.comments.length * 64;
    case "finding":
      return 26;
    default:
      return LINE_HEIGHT;
  }
}

function lineTarget(line: DiffLine): { side: Side; number: number } | null {
  if (line.kind === "context") return line.newNo !== null ? { side: "RIGHT", number: line.newNo } : null;
  if (line.newNo !== null) return { side: "RIGHT", number: line.newNo };
  if (line.oldNo !== null) return { side: "LEFT", number: line.oldNo };
  return null;
}

function threadTarget(thread: Thread): { side: Side; number: number } | null {
  const number = thread.line ?? thread.originalLine;
  if (number === null) return null;
  return { side: thread.diffSide, number };
}

export function FileDiffView({
  repo,
  number,
  path,
  headSha,
  scope,
  theme,
  layout,
  threads,
  findings,
  onComment,
  diffLayout = "inline",
}: {
  repo: string;
  number: number;
  path: string;
  /** Current PR head; stamps any draft comment added here so it can be dropped if the head changes. */
  headSha: string;
  scope: "full" | "since_viewed" | "since_last_review";
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  threads: Thread[];
  findings: FileDiffFinding[];
  onComment?: (draft: DraftComment) => void;
  /** "split" renders old/new side by side; compact layouts always render inline regardless. */
  diffLayout?: "inline" | "split";
}) {
  const c = theme.colors;
  // Compact layouts (narrow viewports) don't have room for two code columns, so they always
  // fall back to the inline path regardless of the caller's requested layout.
  const split = diffLayout === "split" && !layout.compact;
  const rpc = useRpc(fileDiffRpc);
  const toast = useToast();
  const { data: diff, isLoading, error } = useQuery<FileDiff>({
    queryKey: ["prr.fileDiff", repo, number, path, scope],
    queryFn: () => rpc({ repo, number, path, scope }),
  });

  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());
  const [composer, setComposer] = useState<{ side: Side; line: number } | null>(null);
  const [composerBody, setComposerBody] = useState("");

  // Fail open to "light" when the theme doesn't hand back a parseable hex color, rather than
  // silently forcing the dark palette (PluginTheme.colors is typed as plain `string`, with no
  // guaranteed format).
  const surfaceLuminance = luminance(c.surface0);
  const dark = surfaceLuminance !== null && surfaceLuminance < 128;
  const palette = useMemo(() => resolveSyntaxColors("github", dark ? "dark" : "light"), [dark]);

  // Only highlight hunks that are actually visible: lines inside a collapsed moved/whitespace
  // hunk aren't rendered at all until expanded, so there's no reason to pay for tokenizing them
  // up front — especially on a large file, where that eager work can jank the main thread.
  const hunkTokens = useMemo(
    () =>
      diff?.hunks.map((hunk, hunkIndex) => {
        const collapsible = hunk.pureMove || hunk.whitespaceOnly;
        if (collapsible && !expandedHunks.has(hunkIndex)) return [];
        return highlightHunk(hunk, path);
      }) ?? [],
    [diff, path, expandedHunks],
  );

  const rows = useMemo<Row[]>(() => {
    if (!diff) return [];
    const result: Row[] = [];
    if (diff.truncated) result.push({ type: "truncated" });
    diff.hunks.forEach((hunk, hunkIndex) => {
      const collapsible = hunk.pureMove || hunk.whitespaceOnly;
      if (collapsible && !expandedHunks.has(hunkIndex)) {
        result.push(
          hunk.pureMove
            ? { type: "collapsedMoved", hunkIndex, count: hunk.lines.length }
            : { type: "collapsedWhitespace", hunkIndex, count: hunk.lines.length },
        );
        return;
      }
      result.push({ type: "hunkHeader", hunkIndex });
      if (split) {
        pairHunkLines(hunk.lines).forEach(({ oldIndex, newIndex }) => {
          result.push({ type: "pair", hunkIndex, oldIndex, newIndex });
          const oldLine = oldIndex !== null ? hunk.lines[oldIndex] : null;
          const newLine = newIndex !== null ? hunk.lines[newIndex] : null;
          threads.forEach((thread) => {
            const target = threadTarget(thread);
            if (!target) return;
            const matches =
              target.side === "LEFT" ? oldLine !== null && oldLine.oldNo === target.number : newLine !== null && newLine.newNo === target.number;
            if (matches) result.push({ type: "thread", thread });
          });
          findings.forEach((finding) => {
            if (finding.startLine !== null && newLine !== null && newLine.newNo === finding.startLine) {
              result.push({ type: "finding", finding });
            }
          });
        });
        return;
      }
      hunk.lines.forEach((line, lineIndex) => {
        result.push({ type: "line", hunkIndex, lineIndex });
        threads.forEach((thread) => {
          const target = threadTarget(thread);
          if (target && target.number === (target.side === "LEFT" ? line.oldNo : line.newNo)) {
            result.push({ type: "thread", thread });
          }
        });
        findings.forEach((finding) => {
          if (finding.startLine !== null && line.newNo === finding.startLine) {
            result.push({ type: "finding", finding });
          }
        });
      });
    });
    return result;
  }, [diff, expandedHunks, threads, findings, split]);

  // Several row kinds (thread, and hunkHeader/finding on a narrow layout) have genuinely
  // variable height — real comment text wraps, long titles wrap — so `getItemLayout` isn't
  // used: it would tell FlatList to trust a fixed estimate, and any row after a mis-estimated
  // one ends up overlapping or clipped. This is just a rough cap for the scroll window's size;
  // it no longer needs to be exact, so it's fine as a single memoized pass over `rows`.
  const estimatedHeight = useMemo(
    () => Math.min(600, rows.reduce((sum, row) => sum + rowHeight(row), 0) || LINE_HEIGHT),
    [rows],
  );

  function openComposer(side: Side, lineNumber: number) {
    setComposer({ side, line: lineNumber });
    setComposerBody("");
  }

  function submitComposer() {
    if (!composer || !composerBody.trim()) return;
    const draft: DraftComment = { path, line: composer.line, side: composer.side, body: composerBody.trim() };
    addDraft(repo, number, headSha, draft);
    onComment?.(draft);
    toast.show("Draft comment added");
    setComposer(null);
  }

  function renderLine(hunkIndex: number, lineIndex: number) {
    const hunk = diff!.hunks[hunkIndex];
    const line = hunk.lines[lineIndex];
    const tokens = hunkTokens[hunkIndex]?.[lineIndex] ?? [];
    const bg = line.kind === "add" ? c.statusSuccess : line.kind === "del" ? c.statusDanger : null;
    const target = lineTarget(line);
    const content = tokens.length
      ? tokens.map((token, i) => (
          <Text key={i} style={{ color: token.style ? palette[token.style] : c.foreground }}>
            {token.text}
          </Text>
        ))
      : line.text || " ";
    return (
      <View style={{ flexDirection: "row", minHeight: LINE_HEIGHT, opacity: line.moved ? 0.55 : 1 }}>
        {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: bg, opacity: 0.12 }} /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={!target}
          onPress={() => target && openComposer(target.side, target.number)}
          style={{ flexDirection: "row" }}
        >
          <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted }}>{line.oldNo ?? ""}</Text>
          <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted, marginRight: 4 }}>{line.newNo ?? ""}</Text>
        </Pressable>
        <Text style={{ ...code, width: 16, color: bg ?? c.foregroundMuted }}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</Text>
        {line.moved ? <Text style={{ ...code, width: 28, color: c.accent, fontSize: 10 }}>↔ moved</Text> : null}
        <Text selectable style={{ ...code, flex: 1, paddingRight: 12 }} numberOfLines={1}>
          {content}
        </Text>
      </View>
    );
  }

  function renderPairCell(hunkIndex: number, index: number | null, side: "old" | "new") {
    if (index === null) {
      return <View style={{ flex: 1, minHeight: LINE_HEIGHT, backgroundColor: c.surface1, opacity: 0.5 }} />;
    }
    const hunk = diff!.hunks[hunkIndex];
    const line = hunk.lines[index];
    const tokens = hunkTokens[hunkIndex]?.[index] ?? [];
    const tinted = side === "old" ? line.kind === "del" : line.kind === "add";
    const bg = tinted ? (side === "old" ? c.statusDanger : c.statusSuccess) : null;
    const lineNo = side === "old" ? line.oldNo : line.newNo;
    const marker = side === "old" ? (line.kind === "del" ? "−" : " ") : line.kind === "add" ? "+" : " ";
    const target: { side: Side; number: number } | null = lineNo !== null ? { side: side === "old" ? "LEFT" : "RIGHT", number: lineNo } : null;
    const content = tokens.length
      ? tokens.map((token, i) => (
          <Text key={i} style={{ color: token.style ? palette[token.style] : c.foreground }}>
            {token.text}
          </Text>
        ))
      : line.text || " ";
    return (
      <View style={{ flex: 1, flexDirection: "row", minHeight: LINE_HEIGHT, opacity: line.moved ? 0.55 : 1 }}>
        {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: bg, opacity: 0.12 }} /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={!target}
          onPress={() => target && openComposer(target.side, target.number)}
          style={{ flexDirection: "row" }}
        >
          <Text style={{ ...code, width: 38, textAlign: "right", color: c.foregroundMuted }}>{lineNo ?? ""}</Text>
        </Pressable>
        <Text style={{ ...code, width: 16, color: bg ?? c.foregroundMuted }}>{marker}</Text>
        {line.moved ? <Text style={{ ...code, width: 28, color: c.accent, fontSize: 10 }}>↔ moved</Text> : null}
        <Text selectable style={{ ...code, flex: 1, paddingRight: 12 }} numberOfLines={1}>
          {content}
        </Text>
      </View>
    );
  }

  function renderPair(hunkIndex: number, oldIndex: number | null, newIndex: number | null) {
    return (
      <View style={{ flexDirection: "row", minHeight: LINE_HEIGHT }}>
        {renderPairCell(hunkIndex, oldIndex, "old")}
        <View style={{ width: 1, backgroundColor: c.border }} />
        {renderPairCell(hunkIndex, newIndex, "new")}
      </View>
    );
  }

  function renderItem({ item }: { item: Row }) {
    switch (item.type) {
      case "truncated":
        return (
          <View style={{ padding: 8, backgroundColor: c.surface2 }}>
            <Text style={{ color: c.statusWarning, fontSize: 11 }}>Diff truncated — file is too large to show in full.</Text>
          </View>
        );
      case "hunkHeader":
        return (
          <View style={{ minHeight: 26, backgroundColor: c.surface2, justifyContent: "center" }}>
            <Text style={{ ...code, color: c.foregroundMuted, paddingHorizontal: 8 }}>{diff!.hunks[item.hunkIndex].header}</Text>
          </View>
        );
      case "collapsedMoved":
      case "collapsedWhitespace":
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpandedHunks((prev) => new Set(prev).add(item.hunkIndex))}
            style={{ minHeight: 26, backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8 }}
          >
            <Icon name={item.type === "collapsedMoved" ? "ArrowLeftRight" : "Eraser"} size={12} color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
              {item.type === "collapsedMoved" ? `Moved block (${item.count} lines) — show` : `Whitespace-only change (${item.count} lines) — show`}
            </Text>
          </Pressable>
        );
      case "line":
        return renderLine(item.hunkIndex, item.lineIndex);
      case "pair":
        return renderPair(item.hunkIndex, item.oldIndex, item.newIndex);
      case "thread":
        return (
          <View style={{ padding: 8, paddingLeft: 16, backgroundColor: c.surface1, gap: 4 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <Icon name="MessageCircle" size={12} color={c.foregroundMuted} />
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {item.thread.isResolved ? "Resolved" : "Open"} thread{item.thread.isOutdated ? " · outdated" : ""}
              </Text>
            </View>
            {item.thread.comments.map((comment) => (
              <View key={comment.id} style={{ gap: 1 }}>
                <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{comment.author}</Text>
                <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }} numberOfLines={6}>
                  {comment.body}
                </Text>
              </View>
            ))}
          </View>
        );
      case "finding":
        return (
          <View style={{ padding: 6, paddingLeft: 16, backgroundColor: c.surface1, flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Text style={{ color: c.statusDanger, fontSize: 11 }}>
              ✗ {item.finding.validatorTitle} {Math.round(item.finding.probability * 100)}%
            </Text>
          </View>
        );
      default:
        return null;
    }
  }

  if (isLoading) return <Text style={{ color: c.foregroundMuted, padding: 12 }}>Loading diff…</Text>;
  if (error || !diff) return <Text style={{ color: c.statusDanger, padding: 12 }}>Failed to load diff.</Text>;
  if (diff.binary) return <Text style={{ color: c.foregroundMuted, padding: 12 }}>Binary file not shown.</Text>;

  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 5, overflow: "hidden" }}>
      <FlatList
        data={rows}
        keyExtractor={(row, index) => `${row.type}-${index}`}
        renderItem={renderItem}
        initialNumToRender={60}
        windowSize={10}
        style={{ height: estimatedHeight, backgroundColor: c.surface0 }}
      />
      <Modal title={composer ? `Comment on ${path}:${composer.line}` : "Comment"} open={composer !== null} onOpenChange={(open) => !open && setComposer(null)}>
        <Modal.Content>
          <TextInput
            value={composerBody}
            onChangeText={setComposerBody}
            placeholder="Leave a comment…"
            multiline
            style={{ minHeight: 80, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 }}
          />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
            <Pressable accessibilityRole="button" onPress={() => setComposer(null)} style={{ paddingVertical: 6, paddingHorizontal: 12 }}>
              <Text style={{ color: c.foregroundMuted }}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={submitComposer}
              style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: c.accent, borderRadius: 6 }}
            >
              <Text style={{ color: c.accentForeground }}>Add draft comment</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
