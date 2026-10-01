import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { highlightCode, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import { fileDiffRpc } from "../../shared/rpc";
import type { DiffLine, FileDiff, Hunk, Thread, ValidatorFinding } from "../../shared/types";
import { addDraft, type DraftComment } from "../review/drafts";

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
  | { type: "thread"; thread: Thread }
  | { type: "finding"; finding: FileDiffFinding };

const LINE_HEIGHT = 21;
const code = { fontFamily: "monospace", fontSize: 12, lineHeight: LINE_HEIGHT } as const;

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** Highlights one hunk's old- and new-side text in as few highlightCode calls as possible. */
function highlightHunk(hunk: Hunk, path: string): HighlightToken[][] {
  const result: HighlightToken[][] = hunk.lines.map(() => []);
  let oldIndices: number[] = [];
  let newIndices: number[] = [];
  function flush() {
    [oldIndices, newIndices].forEach((indices) => {
      if (indices.length === 0) return;
      const text = indices.map((index) => hunk.lines[index].text).join("\n");
      const tokens = highlightCode(text, path);
      indices.forEach((index, offset) => {
        result[index] = tokens[offset] ?? [];
      });
    });
    oldIndices = [];
    newIndices = [];
  }
  hunk.lines.forEach((line, index) => {
    if (line.oldNo !== null) oldIndices.push(index);
    else if (line.newNo !== null) newIndices.push(index);
  });
  flush();
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
      return LINE_HEIGHT;
    case "thread":
      return 28 + row.thread.comments.length * 46;
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
  scope,
  theme,
  layout,
  threads,
  findings,
  onComment,
}: {
  repo: string;
  number: number;
  path: string;
  scope: "full" | "since_viewed" | "since_last_review";
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  threads: Thread[];
  findings: FileDiffFinding[];
  onComment?: (draft: DraftComment) => void;
}) {
  const c = theme.colors;
  const rpc = useRpc(fileDiffRpc);
  const toast = useToast();
  const { data: diff, isLoading, error } = useQuery<FileDiff>({
    queryKey: ["prr.fileDiff", repo, number, path, scope],
    queryFn: () => rpc({ repo, number, path, scope }),
  });

  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());
  const [composer, setComposer] = useState<{ side: Side; line: number } | null>(null);
  const [composerBody, setComposerBody] = useState("");

  const dark = luminance(c.surface0) < 128;
  const palette = useMemo(() => resolveSyntaxColors("github", dark ? "dark" : "light"), [dark]);

  const hunkTokens = useMemo(
    () => diff?.hunks.map((hunk) => highlightHunk(hunk, path)) ?? [],
    [diff, path],
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
  }, [diff, expandedHunks, threads, findings]);

  const { heights, offsets } = useMemo(() => {
    const heightList = rows.map(rowHeight);
    const offsetList: number[] = [];
    let running = 0;
    heightList.forEach((height) => {
      offsetList.push(running);
      running += height;
    });
    return { heights: heightList, offsets: offsetList };
  }, [rows]);

  const getItemLayout = useCallback(
    (_data: ArrayLike<Row> | null | undefined, index: number) => ({ length: heights[index], offset: offsets[index], index }),
    [heights, offsets],
  );

  function openComposer(side: Side, lineNumber: number) {
    setComposer({ side, line: lineNumber });
    setComposerBody("");
  }

  function submitComposer() {
    if (!composer || !composerBody.trim()) return;
    const draft: DraftComment = { path, line: composer.line, side: composer.side, body: composerBody.trim() };
    addDraft(repo, number, draft);
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
      case "thread":
        return (
          <View style={{ padding: 8, paddingLeft: 16, backgroundColor: c.surface1, gap: 4 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <Icon name="MessageCircle" size={12} color={c.foregroundMuted} />
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                {item.thread.isResolved ? "Resolved" : "Open"} thread{item.thread.isOutdated ? " · outdated" : ""}
              </Text>
            </View>
            {item.thread.comments.map((comment) => (
              <View key={comment.id} style={{ gap: 1 }}>
                <Text style={{ color: c.foreground, fontSize: 11, fontWeight: "600" }}>{comment.author}</Text>
                <Text style={{ color: c.foreground, fontSize: 12 }} numberOfLines={3}>
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

  const height = Math.min(600, rows.reduce((sum, row) => sum + rowHeight(row), 0) || LINE_HEIGHT);

  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 5, overflow: "hidden" }}>
      <FlatList
        data={rows}
        keyExtractor={(row, index) => `${row.type}-${index}`}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={60}
        windowSize={10}
        style={{ height, backgroundColor: c.surface0 }}
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
