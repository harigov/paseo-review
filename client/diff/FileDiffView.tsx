import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { FlatList, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { highlightCode, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import { commentCreateRpc, commentDeleteRpc, commentUpdateRpc, fileDiffRpc, threadReplyRpc } from "../../shared/rpc";
import type { DiffLayout, DiffLine, FileDiff, Hunk, Thread, ValidatorFinding } from "../../shared/types";
import { isDarkSurface } from "../ui/color";
import { addDraft, removeDraft, updateDraft, useDrafts, useFileDrafts, type DraftComment } from "../review/drafts";
import { expandTabs, markWhitespace, pairHunkLines } from "./pairing";

export interface FileDiffFinding extends ValidatorFinding {
  validatorId: string;
  validatorTitle: string;
}

type Side = "LEFT" | "RIGHT";

/** One comment within a review thread (see `Thread` in shared/types). */
type ThreadCommentItem = Thread["comments"][number];

type Row =
  | { type: "truncated" }
  | { type: "hunkHeader"; hunkIndex: number }
  | { type: "collapsedMoved"; hunkIndex: number; count: number }
  | { type: "collapsedWhitespace"; hunkIndex: number; count: number }
  | { type: "line"; hunkIndex: number; lineIndex: number }
  | { type: "pair"; hunkIndex: number; oldIndex: number | null; newIndex: number | null }
  | { type: "thread"; thread: Thread }
  | { type: "finding"; finding: FileDiffFinding }
  | { type: "draft"; draftId: number };

/** Composer modal state: a brand-new comment, editing a not-yet-submitted draft, or editing an
 * already-posted GitHub comment (identified by its node id). */
type ComposerState =
  | { kind: "new"; side: Side; line: number }
  | { kind: "editDraft"; side: Side; line: number; draftId: number }
  | { kind: "editComment"; side: Side; line: number; commentId: string };

const LINE_HEIGHT = 21;
const code = { fontFamily: "monospace", fontSize: 12, lineHeight: LINE_HEIGHT } as const;
// react-native-web applies `white-space: nowrap` to a `numberOfLines={1}` Text, which collapses
// runs of spaces; forcing `pre` keeps indentation (already tab-expanded by `expandTabs`) intact.
const codeText = { ...code, ...(Platform.OS === "web" ? ({ whiteSpace: "pre" } as unknown as object) : {}) };

const DELETE_CONFIRM_MS = 4_000;


/**
 * Highlights one hunk's old- and new-side text in as few highlightCode calls as possible.
 * Context lines belong to *both* reconstructions (they're identical in the old and new file),
 * so both the old (context+deletions) and new (context+additions) sequences are highlighted in
 * hunk order, and the new-side result wins for lines that appear on both sides — that keeps
 * multi-line tokens (block comments, template literals, JSX) correctly continued across a
 * context/addition boundary instead of losing their preceding context.
 *
 * Each line's text is tab-expanded first so the highlighter (and the rendered token widths) see
 * the same fixed-width spacing the user does.
 */
function highlightHunk(hunk: Hunk, path: string): HighlightToken[][] {
  const result: HighlightToken[][] = hunk.lines.map(() => []);
  function highlightGroup(indices: number[]) {
    if (indices.length === 0) return;
    const text = indices.map((index) => expandTabs(hunk.lines[index].text)).join("\n");
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
      // Each comment can now show Edit/Delete plus a reply box, so pad the per-comment estimate.
      return 40 + row.thread.comments.length * 84;
    case "finding":
      return 26;
    case "draft":
      return 92;
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
  diffLayout = "inline",
  threads,
  findings,
  viewer = null,
  onCommented,
}: {
  repo: string;
  number: number;
  path: string;
  /** Current PR head; stamps any draft comment added here so it can be dropped if the head changes, and is sent as `commitSha` for "Comment now". */
  headSha: string;
  scope: "full" | "since_viewed" | "since_last_review";
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  /** "inline" (one column) or "split" (old | new). Split falls back to inline on compact layouts. */
  diffLayout?: DiffLayout;
  threads: Thread[];
  findings: FileDiffFinding[];
  /** Login of the signed-in viewer; comments authored by them get Edit/Delete actions. */
  viewer?: string | null;
  /** Called after any server-side mutation (post/update/delete a comment, reply to a thread) so the parent can refresh PR data. */
  onCommented?: () => void;
}) {
  const c = theme.colors;
  // Compact layouts (narrow viewports) don't have room for two code columns, so they always
  // fall back to the inline path regardless of the caller's requested layout.
  const split = diffLayout === "split" && !layout.compact;
  const rpc = useRpc(fileDiffRpc);
  const createCommentRpc = useRpc(commentCreateRpc);
  const updateCommentRpc = useRpc(commentUpdateRpc);
  const deleteCommentRpc = useRpc(commentDeleteRpc);
  const replyRpc = useRpc(threadReplyRpc);
  const toast = useToast();
  const { data: diff, isLoading, error } = useQuery<FileDiff>({
    queryKey: ["prr.fileDiff", repo, number, path, scope],
    queryFn: () => rpc({ repo, number, path, scope }),
  });

  // `allDrafts` (unfiltered) is what `updateDraft`/`removeDraft` index into — the store keeps one
  // array per PR head across every file, not per path. `fileDrafts` is the path-scoped view used
  // to place draft rows in this file's diff.
  const allDrafts = useDrafts(repo, number, headSha);
  const fileDrafts = useFileDrafts(repo, number, headSha, path);

  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  // Keyed by a per-row string (not component state inside a render helper — renderLine/
  // renderPairCell are plain functions called from renderItem, not components) so the "+" add
  // affordance can light up on hover without violating the rules of hooks.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [replyOpenThreads, setReplyOpenThreads] = useState<Set<string>>(new Set());
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null);

  // Fail open to "light" when the theme doesn't hand back a parseable hex color, rather than
  // silently forcing the dark palette (PluginTheme.colors is typed as plain `string`, with no
  // guaranteed format).
  const dark = isDarkSurface(c.surface0);
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
          fileDrafts.forEach((draft) => {
            const matches =
              draft.side === "LEFT" ? oldLine !== null && oldLine.oldNo === draft.line : newLine !== null && newLine.newNo === draft.line;
            if (matches) result.push({ type: "draft", draftId: draft.id });
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
        fileDrafts.forEach((draft) => {
          const lineNumber = draft.side === "LEFT" ? line.oldNo : line.newNo;
          if (lineNumber === draft.line) result.push({ type: "draft", draftId: draft.id });
        });
        findings.forEach((finding) => {
          if (finding.startLine !== null && line.newNo === finding.startLine) {
            result.push({ type: "finding", finding });
          }
        });
      });
    });
    return result;
  }, [diff, expandedHunks, threads, findings, split, fileDrafts]);

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
    setComposer({ kind: "new", side, line: lineNumber });
    setComposerBody("");
  }

  function openEditDraft(draft: DraftComment) {
    setComposer({ kind: "editDraft", side: draft.side, line: draft.line, draftId: draft.id });
    setComposerBody(draft.body);
  }

  function openEditComment(side: Side, lineNumber: number, comment: ThreadCommentItem) {
    setComposer({ kind: "editComment", side, line: lineNumber, commentId: comment.id });
    setComposerBody(comment.body);
  }

  function closeComposer() {
    setComposer(null);
    setComposerBody("");
  }

  function addToReview() {
    if (!composer || composer.kind !== "new") return;
    const body = composerBody.trim();
    if (!body) return;
    addDraft(repo, number, headSha, { path, line: composer.line, side: composer.side, body });
    toast.show("Draft comment added");
    closeComposer();
  }

  async function commentNow() {
    if (!composer || composer.kind !== "new") return;
    const body = composerBody.trim();
    if (!body) return;
    setComposerBusy(true);
    try {
      await createCommentRpc({ repo, number, path, line: composer.line, side: composer.side, body, commitSha: headSha });
      toast.show("Comment posted");
      onCommented?.();
      closeComposer();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to post the comment");
    } finally {
      setComposerBusy(false);
    }
  }

  async function saveComposer() {
    if (!composer || composer.kind === "new") return;
    const body = composerBody.trim();
    if (!body) return;
    if (composer.kind === "editDraft") {
      const index = allDrafts.findIndex((draft) => draft.id === composer.draftId);
      if (index >= 0) updateDraft(repo, number, headSha, index, body);
      toast.show("Draft updated");
      closeComposer();
      return;
    }
    setComposerBusy(true);
    try {
      const result = await updateCommentRpc({ repo, number, commentId: composer.commentId, body });
      if (!result.ok) throw new Error(result.message ?? "Failed to update the comment");
      toast.show("Comment updated");
      onCommented?.();
      closeComposer();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update the comment");
    } finally {
      setComposerBusy(false);
    }
  }

  function deleteDraft(draft: DraftComment) {
    const index = allDrafts.findIndex((candidate) => candidate.id === draft.id);
    if (index >= 0) removeDraft(repo, number, headSha, index);
  }

  async function deleteComment(commentId: string) {
    try {
      const result = await deleteCommentRpc({ repo, number, commentId });
      if (!result.ok) throw new Error(result.message ?? "Failed to delete the comment");
      toast.show("Comment deleted");
      onCommented?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete the comment");
    }
  }

  function handleDeleteCommentPress(commentId: string) {
    if (pendingDeleteCommentId === commentId) {
      setPendingDeleteCommentId(null);
      void deleteComment(commentId);
      return;
    }
    setPendingDeleteCommentId(commentId);
    setTimeout(() => {
      setPendingDeleteCommentId((current) => (current === commentId ? null : current));
    }, DELETE_CONFIRM_MS);
  }

  function toggleReply(threadId: string) {
    setReplyOpenThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }

  async function sendReply(thread: Thread, resolve: boolean) {
    const body = (replyBodies[thread.id] ?? "").trim();
    if (!body) return;
    setSendingReply(thread.id);
    try {
      const result = await replyRpc({ repo, number, threadId: thread.id, body, resolve });
      if (!result.ok) throw new Error(result.message ?? "Failed to reply");
      toast.show(resolve ? "Replied and resolved" : "Replied");
      setReplyBodies((prev) => ({ ...prev, [thread.id]: "" }));
      setReplyOpenThreads((prev) => {
        const next = new Set(prev);
        next.delete(thread.id);
        return next;
      });
      onCommented?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reply");
    } finally {
      setSendingReply(null);
    }
  }

  function renderAddGutter(gutterKey: string, target: { side: Side; number: number } | null) {
    const hovered = hoverKey === gutterKey;
    return (
      <Pressable
        accessibilityRole="button"
        disabled={!target}
        onPress={() => target && openComposer(target.side, target.number)}
        onHoverIn={() => target && setHoverKey(gutterKey)}
        onHoverOut={() => setHoverKey((prev) => (prev === gutterKey ? null : prev))}
        style={{ width: 18, alignItems: "center", justifyContent: "center" }}
      >
        <Text
          style={{
            fontSize: 13,
            lineHeight: LINE_HEIGHT,
            color: hovered ? c.accent : c.foregroundMuted,
            opacity: target ? (hovered ? 1 : 0.35) : 0,
          }}
        >
          +
        </Text>
      </Pressable>
    );
  }

  function renderLine(hunkIndex: number, lineIndex: number) {
    const hunk = diff!.hunks[hunkIndex];
    const line = hunk.lines[lineIndex];
    const tokens = hunkTokens[hunkIndex]?.[lineIndex] ?? [];
    const bg = line.kind === "add" ? c.statusSuccess : line.kind === "del" ? c.statusDanger : null;
    const target = lineTarget(line);
    const content = line.whitespaceOnly
      ? markWhitespace(line.text)
      : tokens.length
        ? tokens.map((token, i) => (
            <Text key={i} style={{ color: token.style ? palette[token.style] : c.foreground }}>
              {token.text}
            </Text>
          ))
        : expandTabs(line.text) || " ";
    return (
      <View style={{ flexDirection: "row", minHeight: LINE_HEIGHT, opacity: line.moved ? 0.55 : 1 }}>
        {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: bg, opacity: 0.12 }} /> : null}
        {renderAddGutter(`line-${hunkIndex}-${lineIndex}`, target)}
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
        <Text
          selectable
          style={{ ...codeText, flex: 1, paddingRight: 12, ...(line.whitespaceOnly ? { color: c.foregroundMuted, opacity: 0.6 } : null) }}
          numberOfLines={1}
        >
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
    const content = line.whitespaceOnly
      ? markWhitespace(line.text)
      : tokens.length
        ? tokens.map((token, i) => (
            <Text key={i} style={{ color: token.style ? palette[token.style] : c.foreground }}>
              {token.text}
            </Text>
          ))
        : expandTabs(line.text) || " ";
    return (
      <View style={{ flex: 1, flexDirection: "row", minHeight: LINE_HEIGHT, opacity: line.moved ? 0.55 : 1 }}>
        {bg ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: bg, opacity: 0.12 }} /> : null}
        {renderAddGutter(`pair-${hunkIndex}-${index}-${side}`, target)}
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
        <Text
          selectable
          style={{ ...codeText, flex: 1, paddingRight: 12, ...(line.whitespaceOnly ? { color: c.foregroundMuted, opacity: 0.6 } : null) }}
          numberOfLines={1}
        >
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

  function renderDraft(draftId: number) {
    const draft = fileDrafts.find((candidate) => candidate.id === draftId);
    if (!draft) return null;
    return (
      <View style={{ padding: 8, paddingLeft: 16, backgroundColor: c.surface1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: c.accent }}>
            <Text style={{ color: c.accentForeground, fontSize: 10, fontWeight: "600" }}>Draft</Text>
          </View>
        </View>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{draft.body}</Text>
        <View style={{ flexDirection: "row", gap: 14 }}>
          <Pressable accessibilityRole="button" onPress={() => openEditDraft(draft)}>
            <Text style={{ color: c.accent, fontSize: 11 }}>Edit</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => deleteDraft(draft)}>
            <Text style={{ color: c.statusDanger, fontSize: 11 }}>Delete</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderThread(thread: Thread) {
    const target = threadTarget(thread);
    const replyOpen = replyOpenThreads.has(thread.id);
    return (
      <View style={{ padding: 8, paddingLeft: 16, backgroundColor: c.surface1, gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Icon name="MessageCircle" size={12} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {thread.isResolved ? "Resolved" : "Open"} thread{thread.isOutdated ? " · outdated" : ""}
          </Text>
        </View>
        {thread.comments.map((comment) => {
          const mine = viewer !== null && comment.author === viewer;
          const confirmingDelete = pendingDeleteCommentId === comment.id;
          return (
            <View key={comment.id} style={{ gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{comment.author}</Text>
              <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }} numberOfLines={6}>
                {comment.body}
              </Text>
              {mine ? (
                <View style={{ flexDirection: "row", gap: 14 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => openEditComment(target?.side ?? "RIGHT", target?.number ?? 0, comment)}
                  >
                    <Text style={{ color: c.accent, fontSize: 11 }}>Edit</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => handleDeleteCommentPress(comment.id)}>
                    <Text style={{ color: c.statusDanger, fontSize: 11 }}>{confirmingDelete ? "Confirm delete" : "Delete"}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}
        <View style={{ gap: 6 }}>
          <Pressable accessibilityRole="button" onPress={() => toggleReply(thread.id)}>
            <Text style={{ color: c.accent, fontSize: 11 }}>{replyOpen ? "Cancel reply" : "Reply"}</Text>
          </Pressable>
          {replyOpen ? (
            <View style={{ gap: 6 }}>
              <TextInput
                value={replyBodies[thread.id] ?? ""}
                onChangeText={(value) => setReplyBodies((prev) => ({ ...prev, [thread.id]: value }))}
                placeholder="Reply…"
                multiline
                style={{ minHeight: 50, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 6, fontSize: 12 }}
              />
              <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                <Pressable
                  accessibilityRole="button"
                  disabled={sendingReply === thread.id}
                  onPress={() => sendReply(thread, false)}
                  style={{ paddingVertical: 5, paddingHorizontal: 10, backgroundColor: c.surface2, borderRadius: 6 }}
                >
                  <Text style={{ color: c.foreground, fontSize: 11 }}>Reply</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={sendingReply === thread.id}
                  onPress={() => sendReply(thread, true)}
                  style={{ paddingVertical: 5, paddingHorizontal: 10, backgroundColor: c.accent, borderRadius: 6 }}
                >
                  <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                    <Icon name="Check" size={11} color={c.accentForeground} />
                    <Text style={{ color: c.accentForeground, fontSize: 11 }}>Reply &amp; resolve</Text>
                  </View>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
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
            <Text style={{ ...codeText, color: c.foregroundMuted, paddingHorizontal: 8 }}>{diff!.hunks[item.hunkIndex].header}</Text>
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
        return renderThread(item.thread);
      case "draft":
        return renderDraft(item.draftId);
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

  const composerTitle = composer ? `${path}:${composer.line} (${composer.side})` : "Comment";

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
      <Modal title={composerTitle} open={composer !== null} onOpenChange={(open) => !open && closeComposer()}>
        <Modal.Content>
          <TextInput
            value={composerBody}
            onChangeText={setComposerBody}
            placeholder="Leave a comment…"
            multiline
            style={{ minHeight: 120, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 14 }}
          />
          <Text style={{ color: c.foregroundMuted, fontSize: 11, marginTop: 4 }}>Markdown supported</Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
            <Pressable accessibilityRole="button" onPress={closeComposer} style={{ paddingVertical: 6, paddingHorizontal: 12 }}>
              <Text style={{ color: c.foregroundMuted }}>Cancel</Text>
            </Pressable>
            {composer?.kind === "new" ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  disabled={composerBusy || !composerBody.trim()}
                  onPress={addToReview}
                  style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: c.surface2, borderRadius: 6 }}
                >
                  <Text style={{ color: c.foreground }}>Add to review</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={composerBusy || !composerBody.trim()}
                  onPress={commentNow}
                  style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: c.accent, borderRadius: 6 }}
                >
                  <Text style={{ color: c.accentForeground }}>Comment now</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={composerBusy || !composerBody.trim()}
                onPress={saveComposer}
                style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: c.accent, borderRadius: 6 }}
              >
                <Text style={{ color: c.accentForeground }}>Save</Text>
              </Pressable>
            )}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
