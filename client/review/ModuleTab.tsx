import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { FlatList, Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { FlatList as NativeFlatList } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { highlightCode, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import {
  commentCreateRpc,
  commentDeleteRpc,
  commentUpdateRpc,
  fileDiffRpc,
  fileMoveRpc,
  fileViewedRpc,
  threadReplyRpc,
} from "../../shared/rpc";
import type { AnalyzedFile, FileDiff, Hunk, OutlineEntry, Thread, ViewedState } from "../../shared/types";
import type { ModuleTabProps } from "../pr/tab-props";
import { outlineSummary } from "../diff/OutlineView";
import {
  buildStreamRows,
  fileSegments,
  stickyIndices,
  type ComposerTarget,
  type DiffQueryStatus,
  type FileDiffFinding,
  type Row,
  type Side,
  type StreamFileInput,
} from "../diff/rows";
import { renderStreamRow, type StreamRowContext } from "../diff/DiffRows";
import { Minimap, type MinimapScrollMetrics } from "../diff/Minimap";
import { expandTabs } from "../diff/pairing";
import { addDraft, removeDraft, updateDraft, useDrafts, type DraftComment } from "./drafts";
import { isDarkSurface } from "../ui/color";
import { InlineLoading } from "../ui/states";
import { font, space, surfaces } from "../ui/tokens";

type FileViewMode = "text" | "structure";
type DiffScope = "full" | "since_viewed" | "since_last_review";
type ThreadCommentItem = Thread["comments"][number];

/** Structure by default for lockfiles and for large structural files; text everywhere else. */
function defaultViewMode(file: AnalyzedFile): FileViewMode {
  if ((file.structuralKind ?? null) === "lockfile") return "structure";
  if (file.additions + file.deletions > 150) return "structure";
  return "text";
}

/** The outline starts expanded for small outlines, collapsed for large ones. */
function defaultOutlineExpanded(file: AnalyzedFile): boolean {
  return (file.outline?.length ?? 0) <= 12;
}

/** Whether this file's diff needs to be fetched: `rows.ts` only renders the structural row (and
 * skips the text diff) when the mode is "structure" *and* the file actually has a structural
 * kind — a file defaulted to "structure" by size alone (see `defaultViewMode`) without a
 * `structuralKind` still falls back to the text diff, so it still needs fetching. */
function needsTextDiff(file: AnalyzedFile, mode: FileViewMode): boolean {
  return !(mode === "structure" && file.structuralKind);
}

function resolveScope(viewed: ViewedState, sinceViewedPaths: ReadonlySet<string>, path: string, sinceLastReview: boolean): DiffScope {
  if (viewed === "DISMISSED" && sinceViewedPaths.has(path)) return "since_viewed";
  if (sinceLastReview) return "since_last_review";
  return "full";
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

const EMPTY_HUNK_SET: ReadonlySet<number> = new Set();
/** How long a second tap on "Delete" stays armed before reverting to the unarmed label. */
const DELETE_CONFIRM_MS = 4_000;

export function ModuleTab(props: ModuleTabProps) {
  const { theme, analysis, detail, repo, number, moduleId, readingOrder, sinceLastReview, refresh, openChat } = props;
  const c = theme.colors;
  const toast = useToast();
  const viewedRpcCall = useRpc(fileViewedRpc);
  const moveRpc = useRpc(fileMoveRpc);
  const fileDiffFetcher = useRpc(fileDiffRpc);
  const createCommentRpc = useRpc(commentCreateRpc);
  const updateCommentRpc = useRpc(commentUpdateRpc);
  const deleteCommentRpc = useRpc(commentDeleteRpc);
  const replyRpc = useRpc(threadReplyRpc);
  const queryClient = useQueryClient();

  // Prefer the live PR head: file diffs are computed against it, so draft/comment line numbers
  // and the "Comment now" commit must match it even while a re-analysis is still running.
  const headSha = detail?.summary.headSha ?? analysis?.headSha ?? "";

  const moduleInfo = analysis?.modules.find((m) => m.id === moduleId) ?? null;
  const isNoiseModule = (moduleInfo?.title ?? "").toLowerCase() === "noise" || moduleId === "noise";

  const [viewedOverride, setViewedOverride] = useState<Record<string, ViewedState>>({});
  const [moduleOverride, setModuleOverride] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [sinceViewedPaths, setSinceViewedPaths] = useState<Set<string>>(new Set());
  const [outlineExpanded, setOutlineExpanded] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<Record<string, FileViewMode>>({});
  const [expandedHunksByPath, setExpandedHunksByPath] = useState<Record<string, ReadonlySet<number>>>({});
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const [replyOpenThreads, setReplyOpenThreads] = useState<Set<string>>(new Set());
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState<MinimapScrollMetrics | null>(null);

  const listRef = useRef<NativeFlatList<Row> | null>(null);
  const focusRetriedRef = useRef(false);

  // Optimistic overrides exist only to bridge the gap until a fresh `analysis` lands. Once a
  // new snapshot arrives (react-query gives this a new reference only when content actually
  // changed), trust it and stop shadowing — otherwise a later server-side change (e.g. GitHub
  // flips a file back to DISMISSED after a new push) would stay masked forever.
  useEffect(() => {
    setViewedOverride({});
    setModuleOverride({});
    // Deliberately keyed on the analysis object identity, not its fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  const allFiles = analysis?.files ?? [];

  const moduleFiles = useMemo(
    () =>
      allFiles
        .filter((file) => (moduleOverride[file.path] ?? file.moduleId) === moduleId)
        .slice()
        .sort((a, b) => a.order[readingOrder] - b.order[readingOrder]),
    [allFiles, moduleOverride, moduleId, readingOrder],
  );

  const hiddenRebaseOnly = useMemo(
    () => (sinceLastReview ? moduleFiles.filter((file) => file.rebaseOnly && !file.changedSinceLastReview) : []),
    [moduleFiles, sinceLastReview],
  );

  const visibleFiles = useMemo(
    () => (sinceLastReview ? moduleFiles.filter((file) => file.changedSinceLastReview) : moduleFiles),
    [moduleFiles, sinceLastReview],
  );

  // Recompute default expansion only when switching modules or the since-last-review filter.
  useEffect(() => {
    const defaults: Record<string, boolean> = {};
    if (!isNoiseModule) {
      visibleFiles.forEach((file) => {
        defaults[file.path] = file.viewed !== "VIEWED" && file.effectiveLines <= 400;
      });
    }
    setExpanded(defaults);
    // Deliberately scoped to module/filter switches, not every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, sinceLastReview, isNoiseModule]);

  const viewModeByPath = useMemo(() => {
    const map = new Map<string, FileViewMode>();
    visibleFiles.forEach((file) => map.set(file.path, viewMode[file.path] ?? defaultViewMode(file)));
    return map;
  }, [visibleFiles, viewMode]);

  const outlineExpandedByPath = useMemo(() => {
    const map = new Map<string, boolean>();
    visibleFiles.forEach((file) => map.set(file.path, outlineExpanded[file.path] ?? defaultOutlineExpanded(file)));
    return map;
  }, [visibleFiles, outlineExpanded]);

  // One shared store for the whole PR (see client/review/drafts.ts); grouped by path below so
  // placing draft rows doesn't need a hook per file (hooks can't be called in a loop).
  const allDrafts = useDrafts(repo, number, headSha);
  const draftsByPath = useMemo(() => {
    const map = new Map<string, DraftComment[]>();
    allDrafts.forEach((draft) => {
      const list = map.get(draft.path) ?? [];
      list.push(draft);
      map.set(draft.path, list);
    });
    return map;
  }, [allDrafts]);

  // Only expanded, text-mode files need their diff fetched; structure-mode files render via
  // StructuralDiffView, which fetches independently.
  const filesNeedingDiff = useMemo(
    () => visibleFiles.filter((file) => expanded[file.path] === true && needsTextDiff(file, viewModeByPath.get(file.path) ?? "text")),
    [visibleFiles, expanded, viewModeByPath],
  );

  const diffQueries = useQueries({
    queries: filesNeedingDiff.map((file) => {
      const viewed = viewedOverride[file.path] ?? file.viewed;
      const scope = resolveScope(viewed, sinceViewedPaths, file.path, sinceLastReview);
      return {
        queryKey: ["prr.fileDiff", repo, number, file.path, scope] as const,
        queryFn: () => fileDiffFetcher({ repo, number, path: file.path, scope }),
      };
    }),
  });

  const diffByPath = useMemo(() => {
    const map = new Map<string, { status: DiffQueryStatus; diff: FileDiff | null; error: string | null; refetch: () => void }>();
    filesNeedingDiff.forEach((file, index) => {
      const query = diffQueries[index];
      if (!query) return;
      map.set(file.path, {
        status: query.isLoading ? "loading" : query.isError ? "error" : query.isSuccess ? "success" : "idle",
        diff: query.data ?? null,
        error: query.error instanceof Error ? query.error.message : query.isError ? "Failed to load diff." : null,
        refetch: () => void query.refetch(),
      });
    });
    return map;
  }, [filesNeedingDiff, diffQueries]);

  // Fail open to "light" when the theme doesn't hand back a parseable hex color, rather than
  // silently forcing the dark palette (PluginTheme.colors is typed as plain `string`, with no
  // guaranteed format).
  const dark = isDarkSurface(c.surface0);
  const palette = useMemo(() => resolveSyntaxColors("github", dark ? "dark" : "light"), [dark]);

  // Only highlight hunks that actually have rendered rows: lines inside a collapsed
  // moved/whitespace hunk aren't shown at all until expanded, so there's no reason to pay for
  // tokenizing them up front — especially on a large file, where that eager work can jank the
  // main thread.
  const hunkTokensByPath = useMemo(() => {
    const map = new Map<string, HighlightToken[][][]>();
    diffByPath.forEach((entry, path) => {
      if (!entry.diff) return;
      const expandedHunks = expandedHunksByPath[path] ?? EMPTY_HUNK_SET;
      map.set(
        path,
        entry.diff.hunks.map((hunk, hunkIndex) => {
          const collapsible = hunk.pureMove || hunk.whitespaceOnly;
          if (collapsible && !expandedHunks.has(hunkIndex)) return [];
          return highlightHunk(hunk, path);
        }),
      );
    });
    return map;
  }, [diffByPath, expandedHunksByPath]);

  const streamFileInputs: StreamFileInput[] = useMemo(
    () =>
      visibleFiles.map((file) => {
        const viewed = viewedOverride[file.path] ?? file.viewed;
        const isExpanded = expanded[file.path] === true;
        const mode = viewModeByPath.get(file.path) ?? "text";
        const diffEntry = diffByPath.get(file.path);
        const fileThreads = isExpanded ? detail?.threads.filter((thread) => thread.path === file.path) ?? [] : [];
        const fileFindings: FileDiffFinding[] = isExpanded
          ? (analysis?.validators ?? []).flatMap((result) =>
              result.findings
                .filter((finding) => finding.path === file.path)
                .map((finding) => ({ ...finding, validatorId: result.validatorId, validatorTitle: result.title })),
            )
          : [];
        return {
          file,
          expanded: isExpanded,
          viewed,
          mode,
          outlineExpanded: outlineExpandedByPath.get(file.path) ?? true,
          outlineSummary: outlineSummary(file.outline ?? []),
          sinceViewedHighlighted: sinceViewedPaths.has(file.path),
          diffStatus: diffEntry?.status ?? "idle",
          diff: diffEntry?.diff ?? null,
          diffErrorMessage: diffEntry?.error ?? null,
          expandedHunks: expandedHunksByPath[file.path] ?? EMPTY_HUNK_SET,
          threads: fileThreads,
          findings: fileFindings,
          drafts: draftsByPath.get(file.path) ?? [],
        };
      }),
    [
      visibleFiles,
      viewedOverride,
      expanded,
      viewModeByPath,
      diffByPath,
      detail,
      analysis,
      draftsByPath,
      outlineExpandedByPath,
      sinceViewedPaths,
      expandedHunksByPath,
    ],
  );

  const split = props.diffLayout === "split" && !props.layout.compact;
  const emptyReason: "no_files" | "since_last_review" | undefined =
    visibleFiles.length === 0 ? (sinceLastReview && moduleFiles.length > 0 ? "since_last_review" : "no_files") : undefined;

  const rows = useMemo(
    () => buildStreamRows({ files: streamFileInputs, split, composer, emptyReason }),
    [streamFileInputs, split, composer, emptyReason],
  );
  const stickyHeaderIndices = useMemo(() => stickyIndices(rows), [rows]);
  const segments = useMemo(() => fileSegments(rows), [rows]);

  // Prefetch the next unviewed file's diff as soon as a file expands, so paging through the
  // module in reading order rarely shows a loading row.
  useEffect(() => {
    visibleFiles.forEach((file) => {
      if (expanded[file.path] !== true) return;
      const index = visibleFiles.findIndex((candidate) => candidate.path === file.path);
      const next = visibleFiles.slice(index + 1).find((candidate) => (viewedOverride[candidate.path] ?? candidate.viewed) !== "VIEWED");
      if (!next) return;
      const nextMode = viewModeByPath.get(next.path) ?? defaultViewMode(next);
      if (!needsTextDiff(next, nextMode)) return;
      const nextViewed = viewedOverride[next.path] ?? next.viewed;
      const scope = resolveScope(nextViewed, sinceViewedPaths, next.path, sinceLastReview);
      void queryClient.prefetchQuery({
        queryKey: ["prr.fileDiff", repo, number, next.path, scope],
        queryFn: () => fileDiffFetcher({ repo, number, path: next.path, scope }),
      });
    });
  }, [expanded, visibleFiles, viewedOverride, viewModeByPath, sinceViewedPaths, sinceLastReview, repo, number, queryClient, fileDiffFetcher]);

  function scrollToFile(path: string) {
    const index = rows.findIndex((row) => row.type === "fileHeader" && row.path === path);
    if (index !== -1) listRef.current?.scrollToIndex({ index, viewPosition: 0 });
  }

  // `focusPath` (set by "Next unviewed" or the outline) asks this tab to expand a file and
  // scroll its sticky header into view, then clear itself. Expanding can add rows ahead of this
  // file's header (if an earlier file is also expanded), so the header's index is only looked
  // up once `rows` has settled after the expansion commits.
  useEffect(() => {
    if (!props.focusPath) {
      focusRetriedRef.current = false;
      return;
    }
    const path = props.focusPath;
    const match = visibleFiles.find((file) => file.path === path);
    if (!match) {
      props.setFocusPath(null);
      return;
    }
    if (expanded[path] !== true) {
      setExpanded((prev) => ({ ...prev, [path]: true }));
      return;
    }
    const index = rows.findIndex((row) => row.type === "fileHeader" && row.path === path);
    if (index === -1) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0 });
    props.setFocusPath(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusPath, visibleFiles, expanded, rows]);

  function handleScrollToIndexFailed(info: { index: number; averageItemLength: number }) {
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    if (focusRetriedRef.current) return;
    focusRetriedRef.current = true;
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0 });
    }, 60);
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    setScrollMetrics({ offset: contentOffset.y, viewportHeight: layoutMeasurement.height, contentHeight: contentSize.height });
  }

  async function toggleViewed(file: AnalyzedFile, viewed: boolean) {
    const previous = viewedOverride[file.path];
    setViewedOverride((prev) => ({ ...prev, [file.path]: viewed ? "VIEWED" : "UNVIEWED" }));
    try {
      const result = await viewedRpcCall({ repo, number, path: file.path, viewed });
      // Trust the server's authoritative state rather than our own guess.
      setViewedOverride((prev) => ({ ...prev, [file.path]: result.viewed }));
    } catch (error) {
      // Revert the optimistic guess instead of leaving it stuck on a wrong value forever.
      setViewedOverride((prev) => {
        const next = { ...prev };
        if (previous === undefined) delete next[file.path];
        else next[file.path] = previous;
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Failed to update viewed state");
    } finally {
      refresh();
    }
  }

  async function moveFile(file: AnalyzedFile, targetModuleId: string) {
    const previous = moduleOverride[file.path];
    setModuleOverride((prev) => ({ ...prev, [file.path]: targetModuleId }));
    setMovingPath(null);
    try {
      await moveRpc({ repo, number, path: file.path, moduleId: targetModuleId });
      toast.show(`Moved ${file.path}`);
    } catch (error) {
      setModuleOverride((prev) => {
        const next = { ...prev };
        if (previous === undefined) delete next[file.path];
        else next[file.path] = previous;
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Failed to move file");
    } finally {
      refresh();
    }
  }

  /** Marks every unviewed visible file viewed, one RPC at a time (each optimistic), then a
   * single `refresh()` at the end — unlike `toggleViewed`, which refreshes after every call. */
  async function markModuleViewed() {
    const unviewed = visibleFiles.filter((file) => (viewedOverride[file.path] ?? file.viewed) !== "VIEWED");
    for (const file of unviewed) {
      const previous = viewedOverride[file.path];
      setViewedOverride((prev) => ({ ...prev, [file.path]: "VIEWED" }));
      try {
        const result = await viewedRpcCall({ repo, number, path: file.path, viewed: true });
        setViewedOverride((prev) => ({ ...prev, [file.path]: result.viewed }));
      } catch (error) {
        setViewedOverride((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[file.path];
          else next[file.path] = previous;
          return next;
        });
        toast.error(error instanceof Error ? error.message : `Failed to mark ${file.path} viewed`);
      }
    }
    refresh();
  }

  function toggleExpand(path: string) {
    setExpanded((prev) => ({ ...prev, [path]: prev[path] !== true }));
  }

  function toggleOutline(path: string) {
    const current = outlineExpandedByPath.get(path) ?? true;
    setOutlineExpanded((prev) => ({ ...prev, [path]: !current }));
  }

  function selectOutlineEntry(path: string, _entry: OutlineEntry) {
    // v1: no scroll-to-line API in the stream yet, so selecting an outline row just makes sure
    // the file's diff is visible in text mode.
    setExpanded((prev) => ({ ...prev, [path]: true }));
    setViewMode((prev) => ({ ...prev, [path]: "text" }));
  }

  function revealSinceViewed(path: string) {
    setSinceViewedPaths((prev) => new Set(prev).add(path));
  }

  function setViewModeFor(path: string, mode: FileViewMode) {
    setViewMode((prev) => ({ ...prev, [path]: mode }));
  }

  function expandHunk(path: string, hunkIndex: number) {
    setExpandedHunksByPath((prev) => {
      const set = new Set(prev[path] ?? []);
      set.add(hunkIndex);
      return { ...prev, [path]: set };
    });
  }

  function openComposer(path: string, side: Side, line: number) {
    setComposer({ path, side, line, mode: "new" });
    setComposerBody("");
  }

  function openEditDraft(draft: DraftComment) {
    setComposer({ path: draft.path, side: draft.side, line: draft.line, mode: "editDraft", draftId: draft.id });
    setComposerBody(draft.body);
  }

  function openEditComment(path: string, side: Side, line: number, comment: ThreadCommentItem) {
    setComposer({ path, side, line, mode: "editComment", commentId: comment.id });
    setComposerBody(comment.body);
  }

  function closeComposer() {
    setComposer(null);
    setComposerBody("");
  }

  function addToReview() {
    if (!composer || composer.mode !== "new") return;
    const body = composerBody.trim();
    if (!body) return;
    addDraft(repo, number, headSha, { path: composer.path, line: composer.line, side: composer.side, body });
    toast.show("Draft comment added");
    closeComposer();
  }

  async function commentNow() {
    if (!composer || composer.mode !== "new") return;
    const body = composerBody.trim();
    if (!body) return;
    setComposerBusy(true);
    try {
      await createCommentRpc({ repo, number, path: composer.path, line: composer.line, side: composer.side, body, commitSha: headSha });
      toast.show("Comment posted");
      refresh();
      closeComposer();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to post the comment");
    } finally {
      setComposerBusy(false);
    }
  }

  async function saveComposer() {
    if (!composer || composer.mode === "new") return;
    const body = composerBody.trim();
    if (!body) return;
    if (composer.mode === "editDraft") {
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
      refresh();
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
      refresh();
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
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reply");
    } finally {
      setSendingReply(null);
    }
  }

  function getHunk(path: string, hunkIndex: number): Hunk | undefined {
    return diffByPath.get(path)?.diff?.hunks[hunkIndex];
  }
  function getTokens(path: string, hunkIndex: number): HighlightToken[][] {
    return hunkTokensByPath.get(path)?.[hunkIndex] ?? [];
  }
  function getDraft(path: string, draftId: number): DraftComment | undefined {
    return draftsByPath.get(path)?.find((draft) => draft.id === draftId);
  }

  function isFileViewed(path: string): boolean {
    const file = visibleFiles.find((candidate) => candidate.path === path);
    return file ? (viewedOverride[file.path] ?? file.viewed) === "VIEWED" : false;
  }

  const ctx: StreamRowContext = {
    theme,
    layout: props.layout,
    density: props.diffDensity,
    repo,
    number,
    headSha,
    viewer: detail?.viewer ?? null,
    palette,
    getHunk,
    getTokens,
    getDraft,
    onToggleViewed: (file) => void toggleViewed(file, (viewedOverride[file.path] ?? file.viewed) !== "VIEWED"),
    onToggleExpand: toggleExpand,
    onOpenMove: (path) => setMovingPath(path),
    onToggleOutline: toggleOutline,
    onSelectOutlineEntry: selectOutlineEntry,
    onRevealSinceViewed: revealSinceViewed,
    onSetViewMode: setViewModeFor,
    viewModeOf: (path) => viewModeByPath.get(path) ?? "text",
    onExpandHunk: expandHunk,
    hoverKey,
    onHoverGutter: setHoverKey,
    hoveredRowKey,
    onHoverRow: setHoveredRowKey,
    onOpenComposer: openComposer,
    isReplyOpen: (threadId) => replyOpenThreads.has(threadId),
    onToggleReply: toggleReply,
    replyBodyOf: (threadId) => replyBodies[threadId] ?? "",
    onChangeReplyBody: (threadId, text) => setReplyBodies((prev) => ({ ...prev, [threadId]: text })),
    sendingReplyId: sendingReply,
    onSendReply: sendReply,
    pendingDeleteCommentId,
    onPressDeleteComment: handleDeleteCommentPress,
    onOpenEditComment: openEditComment,
    onOpenEditDraft: openEditDraft,
    onDeleteDraft: deleteDraft,
    composerBody,
    onChangeComposerBody: setComposerBody,
    composerBusy,
    onCancelComposer: closeComposer,
    onAddToReview: addToReview,
    onCommentNow: commentNow,
    onSaveComposer: saveComposer,
    onRetryDiff: (path) => diffByPath.get(path)?.refetch(),
  };

  function renderItem({ item }: { item: Row }) {
    return renderStreamRow(item, ctx);
  }

  const viewedCount = moduleFiles.filter((file) => (viewedOverride[file.path] ?? file.viewed) === "VIEWED").length;
  const effectiveLines = moduleFiles.reduce((sum, file) => sum + file.effectiveLines, 0);
  const otherModules = analysis?.modules.filter((m) => m.id !== moduleId) ?? [];
  const movingFile = movingPath ? moduleFiles.find((file) => file.path === movingPath) ?? null : null;

  if (!analysis) {
    return (
      <View style={{ flex: 1, padding: space.lg }}>
        <InlineLoading theme={theme} label="Loading module…" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: space.xs, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <Text style={{ ...font.heading, color: c.foreground, flex: 1 }}>{moduleInfo?.title ?? moduleId}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              openChat(`Module: ${moduleInfo?.title ?? moduleId}\n\nFiles:\n${moduleFiles.map((file) => `- ${file.path}`).join("\n")}`)
            }
            style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: space.sm, paddingVertical: space.xs }}
          >
            <Icon name="MessageSquare" size={13} color={c.accent} />
            <Text style={{ ...font.small, color: c.accent }}>Ask about this module</Text>
          </Pressable>
        </View>
        {moduleInfo?.description ? <Text style={{ ...font.small, color: c.foregroundMuted }}>{moduleInfo.description}</Text> : null}
        {moduleInfo?.summary ? <Text style={{ ...font.small, color: c.foreground }}>{moduleInfo.summary}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <Text style={{ ...font.caption, color: c.foregroundMuted }}>
            {viewedCount} of {moduleFiles.length} viewed · {effectiveLines} effective lines
          </Text>
          {viewedCount < moduleFiles.length ? (
            <Pressable accessibilityRole="button" onPress={() => void markModuleViewed()} style={surfaces(c).buttonQuiet}>
              <Text style={surfaces(c).buttonQuietText}>Mark module viewed</Text>
            </Pressable>
          ) : null}
        </View>
        {hiddenRebaseOnly.length > 0 ? (
          <Text style={{ ...font.caption, color: c.foregroundMuted }}>
            {hiddenRebaseOnly.length} file(s) hidden (rebase-only): {hiddenRebaseOnly.map((file) => file.path).join(", ")}
          </Text>
        ) : null}
      </View>

      <View style={{ flex: 1, flexDirection: "row" }}>
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          stickyHeaderIndices={stickyHeaderIndices}
          initialNumToRender={40}
          windowSize={7}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onScrollToIndexFailed={handleScrollToIndexFailed}
        />
        {!props.layout.compact && segments.length > 0 ? (
          <Minimap theme={theme} segments={segments} isViewed={isFileViewed} scrollMetrics={scrollMetrics} onPressSegment={scrollToFile} />
        ) : null}
      </View>

      <Modal title="Move to module" open={movingFile !== null} onOpenChange={(open) => !open && setMovingPath(null)}>
        <Modal.Content>
          <View style={{ gap: 6 }}>
            {otherModules.map((module) => (
              <Pressable
                key={module.id}
                accessibilityRole="button"
                onPress={() => movingFile && moveFile(movingFile, module.id)}
                style={{ padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}
              >
                <Text style={{ color: c.foreground, fontSize: 13 }}>{module.title}</Text>
              </Pressable>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
