import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { FlatList, Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { FlatList as NativeFlatList } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { highlightCode, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import {
  commentCreateRpc,
  commentDeleteRpc,
  commentUpdateRpc,
  fileDiffRpc,
  fileLinesRpc,
  fileMoveRpc,
  fileViewedRpc,
  threadReplyRpc,
} from "../../shared/rpc";
import type { AnalyzedFile, FileDiff, Hunk, OutlineEntry, Thread, ViewedState } from "../../shared/types";
import type { ModuleTabProps } from "../pr/tab-props";
import {
  buildStreamRows,
  fileSegments,
  outlineSummary,
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
import { CONTEXT_PAGE_SIZE, gapsForFile, mergeContextLines, type ContextGap, type ContextGapPosition } from "../diff/context";
import {
  moveCursor,
  nextFileIndex,
  nextFileWithUnresolved,
  nextHunkIndex,
  nextUnresolvedIndex,
  nextUnviewedPath,
  type NavDirection,
  type UnresolvedFindingLike,
} from "../diff/keyboard";
import { intralineForPairs, type Span } from "../diff/intraline";
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

/**
 * Word-level emphasis spans for one hunk's del/add lines, pairing each maximal del-run with the
 * add-run immediately after it the same way `pairHunkLines` does (del[k] with add[k]), via
 * `intralineForPairs`. A line with no counterpart (an unequal-length run's leftover lines) or
 * whose pair differs too much to be worth highlighting (`whole: true`) gets `null` — same for a
 * whitespace-only line, which stays on the marker path instead. Operates on whatever `hunk.lines`
 * it's given, so it works the same whether or not context-expansion lines have been spliced in
 * (those are always `context` kind, so they're simply skipped over).
 */
function computeIntralineForHunk(hunk: Hunk): Array<Span[] | null> {
  const result: Array<Span[] | null> = hunk.lines.map(() => null);
  let i = 0;
  while (i < hunk.lines.length) {
    if (hunk.lines[i].kind !== "del") {
      i += 1;
      continue;
    }
    const delStart = i;
    let delEnd = delStart;
    while (delEnd < hunk.lines.length && hunk.lines[delEnd].kind === "del") delEnd += 1;
    const addStart = delEnd;
    let addEnd = addStart;
    while (addEnd < hunk.lines.length && hunk.lines[addEnd].kind === "add") addEnd += 1;
    const delTexts = hunk.lines.slice(delStart, delEnd).map((line) => expandTabs(line.text));
    const addTexts = hunk.lines.slice(addStart, addEnd).map((line) => expandTabs(line.text));
    if (delTexts.length > 0 && addTexts.length > 0) {
      const pairResults = intralineForPairs(delTexts, addTexts);
      const matched = Math.min(delTexts.length, addTexts.length);
      for (let k = 0; k < matched; k += 1) {
        const pair = pairResults[k];
        if (pair.whole) continue;
        const delLine = hunk.lines[delStart + k];
        const addLine = hunk.lines[addStart + k];
        if (!delLine.whitespaceOnly) result[delStart + k] = pair.old;
        if (!addLine.whitespaceOnly) result[addStart + k] = pair.new;
      }
    }
    i = addEnd;
  }
  return result;
}

/** Count of a gap's lines already present in `fetched`, scanning from whichever end the gap
 * fills from first — "above" fills from the end nearest the hunk (backward); "between"/"below"
 * fill from the start nearest the neighboring hunk (forward). Stops at the first missing line,
 * since a press always extends a *contiguous* run from that boundary. */
function countFetchedInGap(fetched: ReadonlyMap<number, string>, gap: ContextGap): number {
  let n = 0;
  if (gap.position === "above") {
    let newNo = gap.newStart + gap.count - 1;
    while (n < gap.count && fetched.has(newNo)) {
      n += 1;
      newNo -= 1;
    }
  } else {
    let newNo = gap.newStart;
    while (n < gap.count && fetched.has(newNo)) {
      n += 1;
      newNo += 1;
    }
  }
  return n;
}

/** Generic incremental per-path cache: recomputes `compute(path, key)` only for paths whose `key`
 * changed (by `keyEqual`) since the last call, reusing the cached value otherwise. Used to keep
 * `effectiveHunksByPath` / `hunkTokensByPath` / `hunkIntralineByPath` from redoing expensive work
 * (context-line merging, syntax highlighting, intraline diffing) for files nothing changed about,
 * just because *some* file's diff, context fetch, or expanded-hunks set changed. */
function incrementalPerPath<K, V>(
  cacheRef: { current: Map<string, { key: K; value: V }> },
  paths: Iterable<string>,
  computeKey: (path: string) => K | null,
  keyEqual: (a: K, b: K) => boolean,
  compute: (path: string, key: K) => V,
): Map<string, V> {
  const cache = cacheRef.current;
  const nextCache = new Map<string, { key: K; value: V }>();
  const result = new Map<string, V>();
  for (const path of paths) {
    const key = computeKey(path);
    if (key === null) continue;
    const cached = cache.get(path);
    if (cached && keyEqual(cached.key, key)) {
      nextCache.set(path, cached);
      result.set(path, cached.value);
    } else {
      const value = compute(path, key);
      nextCache.set(path, { key, value });
      result.set(path, value);
    }
  }
  cacheRef.current = nextCache;
  return result;
}

/** Row-level memo comparator: skips re-rendering a row whose own data (`row`, by reference) and
 * position (`index`, for the cursor border) are unchanged, and whose row-type-specific slice of
 * `ctx` is unchanged — so typing in the composer only re-renders the composer row, and moving
 * the line cursor only re-renders the two rows whose cursor status flipped, instead of every
 * visible row (perf item: `ctx` itself is a fresh object every render). Row types not special-
 * cased here (outline, fileMeta, structural, hunk header, collapsed, truncated…) always re-render
 * when `ctx` changes identity — they're comparatively rare per file, so that's an acceptable
 * trade rather than exhaustively special-casing every row type. */
function rowPropsEqual(
  prev: { row: Row; index: number; ctx: StreamRowContext },
  next: { row: Row; index: number; ctx: StreamRowContext },
): boolean {
  if (prev.row !== next.row || prev.index !== next.index) return false;
  const a = prev.ctx;
  const b = next.ctx;
  if (a === b) return true;
  if (a.theme !== b.theme || a.layout !== b.layout || a.density !== b.density || a.palette !== b.palette) return false;
  const row = prev.row;
  if ((a.cursorIndex === next.index) !== (b.cursorIndex === next.index)) return false;
  switch (row.type) {
    case "fileHeader":
      return (a.currentPath === row.path) === (b.currentPath === row.path) && a.viewModeOf(row.path) === b.viewModeOf(row.path);
    case "line": {
      // Only this row's own hover state matters — comparing `hoverKey`/`hoveredRowKey` directly
      // (their raw values) would re-render every visible code row on any hover change anywhere
      // in the file, since those are single shared fields, not per-row.
      const rowKey = `row-line-${row.path}-${row.hunkIndex}-${row.lineIndex}`;
      const gutterKey = `line-${row.path}-${row.hunkIndex}-${row.lineIndex}`;
      return (
        a.getHunk(row.path, row.hunkIndex) === b.getHunk(row.path, row.hunkIndex) &&
        a.getTokens(row.path, row.hunkIndex) === b.getTokens(row.path, row.hunkIndex) &&
        a.getIntraline(row.path, row.hunkIndex) === b.getIntraline(row.path, row.hunkIndex) &&
        (a.hoveredRowKey === rowKey) === (b.hoveredRowKey === rowKey) &&
        (a.hoverKey === gutterKey) === (b.hoverKey === gutterKey)
      );
    }
    case "pair": {
      const rowKey = `row-pair-${row.path}-${row.hunkIndex}-${row.oldIndex ?? "x"}-${row.newIndex ?? "x"}`;
      const oldGutterKey = `pair-${row.path}-${row.hunkIndex}-${row.oldIndex ?? "x"}-old`;
      const newGutterKey = `pair-${row.path}-${row.hunkIndex}-${row.newIndex ?? "x"}-new`;
      return (
        a.getHunk(row.path, row.hunkIndex) === b.getHunk(row.path, row.hunkIndex) &&
        a.getTokens(row.path, row.hunkIndex) === b.getTokens(row.path, row.hunkIndex) &&
        a.getIntraline(row.path, row.hunkIndex) === b.getIntraline(row.path, row.hunkIndex) &&
        (a.hoveredRowKey === rowKey) === (b.hoveredRowKey === rowKey) &&
        (a.hoverKey === oldGutterKey) === (b.hoverKey === oldGutterKey) &&
        (a.hoverKey === newGutterKey) === (b.hoverKey === newGutterKey)
      );
    }
    case "composer":
      return a.composerBody === b.composerBody && a.composerBusy === b.composerBusy;
    case "thread":
      return (
        a.isReplyOpen(row.thread.id) === b.isReplyOpen(row.thread.id) &&
        a.replyBodyOf(row.thread.id) === b.replyBodyOf(row.thread.id) &&
        a.sendingReplyId === b.sendingReplyId &&
        a.pendingDeleteCommentId === b.pendingDeleteCommentId
      );
    case "draft":
      return a.getDraft(row.path, row.draftId) === b.getDraft(row.path, row.draftId);
    case "expandContext": {
      const key = `${row.path}:${row.position}:${row.hunkIndex}`;
      return a.contextPending.has(key) === b.contextPending.has(key);
    }
    default:
      return false;
  }
}

const StreamRowItem = memo(function StreamRowItem({ row, index, ctx }: { row: Row; index: number; ctx: StreamRowContext }) {
  return renderStreamRow(row, index, ctx);
}, rowPropsEqual);

/** Minimal shape of a DOM `KeyboardEvent` this module needs — `tsconfig.client.json` has no DOM
 * lib (RN/web dual target), so the real type isn't available; this covers everything the
 * keydown handler reads. */
interface DomKeyboardEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
  preventDefault(): void;
}

const SHORTCUTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "j / k", label: "Next / previous file" },
  { key: "e", label: "Expand / collapse the current file" },
  { key: "v", label: "Mark the current file viewed, then go to the next unviewed file" },
  { key: "n", label: "Next unresolved thread or failing finding" },
  { key: "[ / ]", label: "Previous / next hunk" },
  { key: "↑ / ↓", label: "Move the line cursor" },
  { key: "c", label: "Comment at the cursor" },
  { key: "?", label: "Toggle this shortcut sheet" },
];

const EMPTY_HUNK_SET: ReadonlySet<number> = new Set();
const EMPTY_CONTEXT_MAP: ReadonlyMap<number, string> = new Map();
/** How long a second tap on "Delete" stays armed before reverting to the unarmed label. */
const DELETE_CONFIRM_MS = 4_000;
/** How long after a keyboard-driven scroll to ignore `onViewableItemsChanged`'s own idea of
 * `currentPath`, so the scroll settling doesn't immediately overwrite what the key press set. */
const KEYBOARD_NAV_SETTLE_MS = 500;

export function ModuleTab(props: ModuleTabProps) {
  const { theme, analysis, detail, repo, number, moduleId, readingOrder, sinceLastReview, refresh, openChat } = props;
  const c = theme.colors;
  const toast = useToast();
  const viewedRpcCall = useRpc(fileViewedRpc);
  const moveRpc = useRpc(fileMoveRpc);
  const fileDiffFetcher = useRpc(fileDiffRpc);
  const fileLinesFetcher = useRpc(fileLinesRpc);
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
  const [contextFetchedByPath, setContextFetchedByPath] = useState<Record<string, ReadonlyMap<number, string>>>({});
  const [contextPending, setContextPending] = useState<ReadonlySet<string>>(new Set());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // Identifies the cursor row by its stable `key`, not its raw index — `rows` gets rebuilt (and
  // every row's index can shift) on collapse/expand, context fetches, a refresh, or a module
  // switch, which would otherwise leave the cursor border (and `c`) on an unrelated row. The
  // index is resolved from the key lazily (and memoised) just below.
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);

  const listRef = useRef<NativeFlatList<Row> | null>(null);
  const focusRetriedRef = useRef(false);
  const keyboardNavUntilRef = useRef(0);
  const viewableRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: -1 });
  // The path a keyboard-driven jump to the next unresolved thread/finding is waiting to land on
  // once that (currently collapsed) file's rows exist — see `jumpToUnresolved`.
  const pendingUnresolvedTargetRef = useRef<string | null>(null);
  const effectiveHunksCacheRef = useRef(new Map<string, { key: { diff: FileDiff; fetched: ReadonlyMap<number, string> }; value: Hunk[] }>());
  const hunkTokensCacheRef = useRef(new Map<string, { key: { hunks: Hunk[]; expandedHunks: ReadonlySet<number> }; value: HighlightToken[][][] }>());
  const hunkIntralineCacheRef = useRef(
    new Map<string, { key: { hunks: Hunk[]; expandedHunks: ReadonlySet<number> }; value: Array<Array<Span[] | null>> }>(),
  );
  // The freshest `headSha`, read from inside async callbacks (e.g. a context-line fetch) that
  // close over whatever `headSha` was current when they *started* — so they can tell whether a
  // push landed (and reset state) before they resolved, and skip applying a now-stale result.
  const headShaRef = useRef(headSha);
  headShaRef.current = headSha;

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

  // Fetched context lines are tied to a specific head commit; a new push invalidates them (line
  // numbers can shift, and a fetch from before the push would be wrong — see `headShaRef` above
  // for in-flight fetches specifically).
  useEffect(() => {
    setContextFetchedByPath({});
  }, [headSha]);

  // The cursor and current-file tracking are row/path identities scoped to whatever module is
  // showing; switching modules invalidates both (a stale cursor key almost certainly doesn't
  // exist in the new module's rows, but even a coincidental match would be the wrong row).
  useEffect(() => {
    setCursorKey(null);
    setCurrentPath(null);
  }, [moduleId]);

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

  // Grouped by path (independent of any file's expanded state, unlike `streamFileInputs`'
  // per-file `threads`/`findings`) so `jumpToUnresolved` can check a *collapsed* file for an
  // unresolved item without needing it expanded first.
  const threadsByPath = useMemo(() => {
    const map = new Map<string, Thread[]>();
    (detail?.threads ?? []).forEach((thread) => {
      const list = map.get(thread.path);
      if (list) list.push(thread);
      else map.set(thread.path, [thread]);
    });
    return map;
  }, [detail]);
  const findingsByPath = useMemo(() => {
    const map = new Map<string, UnresolvedFindingLike[]>();
    (analysis?.validators ?? []).forEach((result) => {
      result.findings.forEach((finding) => {
        if (finding.path === null) return;
        const list = map.get(finding.path);
        if (list) list.push(finding);
        else map.set(finding.path, [finding]);
      });
    });
    return map;
  }, [analysis]);

  // Only expanded, text-mode files need their diff fetched; structure-mode files render via
  // StructuralDiffView, which fetches independently.
  const filesNeedingDiff = useMemo(
    () => visibleFiles.filter((file) => expanded[file.path] === true && needsTextDiff(file, viewModeByPath.get(file.path) ?? "text")),
    [visibleFiles, expanded, viewModeByPath],
  );

  // `combine` lets react-query structurally share its result across renders: when every query's
  // own `data`/`status` is unchanged, `diffResults` (and everything derived from it below) keeps
  // the same reference instead of being a new array/map of new objects on every render — e.g.
  // every keystroke in the composer, which touches state this hook doesn't depend on at all.
  const combineDiffResults = useCallback(
    (results: UseQueryResult<FileDiff>[]) =>
      results.map((query, index) => {
        const path = filesNeedingDiff[index]?.path ?? "";
        return {
          path,
          status: (query.isLoading ? "loading" : query.isError ? "error" : query.isSuccess ? "success" : "idle") as DiffQueryStatus,
          diff: query.data ?? null,
          error: query.error instanceof Error ? query.error.message : query.isError ? "Failed to load diff." : null,
          refetch: () => void query.refetch(),
        };
      }),
    [filesNeedingDiff],
  );

  const diffResults = useQueries({
    queries: filesNeedingDiff.map((file) => {
      const viewed = viewedOverride[file.path] ?? file.viewed;
      const scope = resolveScope(viewed, sinceViewedPaths, file.path, sinceLastReview);
      return {
        queryKey: ["prr.fileDiff", repo, number, file.path, scope] as const,
        queryFn: () => fileDiffFetcher({ repo, number, path: file.path, scope }),
      };
    }),
    combine: combineDiffResults,
  });

  const diffByPath = useMemo(() => {
    const map = new Map<string, { status: DiffQueryStatus; diff: FileDiff | null; error: string | null; refetch: () => void }>();
    diffResults.forEach((entry) => {
      if (entry.path) map.set(entry.path, entry);
    });
    return map;
  }, [diffResults]);

  // Fail open to "light" when the theme doesn't hand back a parseable hex color, rather than
  // silently forcing the dark palette (PluginTheme.colors is typed as plain `string`, with no
  // guaranteed format).
  const dark = isDarkSurface(c.surface0);
  const palette = useMemo(() => resolveSyntaxColors("github", dark ? "dark" : "light"), [dark]);

  // Splices fetched context lines around each hunk (prepended "above"/"between" context, and —
  // for the last hunk — appended "below" context), producing the `lines` every other per-hunk
  // derivation (highlighting, intraline, and the stream's own `line`/`pair` row addressing in
  // rows.ts) treats as that hunk's full content. Cached per path: unaffected files keep the same
  // `Hunk[]` reference across renders (see `incrementalPerPath`), which is what lets the caches
  // below skip re-highlighting / re-diffing them too.
  const effectiveHunksByPath = useMemo(
    () =>
      incrementalPerPath(
        effectiveHunksCacheRef,
        diffByPath.keys(),
        (path) => {
          const diff = diffByPath.get(path)?.diff;
          return diff ? { diff, fetched: contextFetchedByPath[path] ?? EMPTY_CONTEXT_MAP } : null;
        },
        (a, b) => a.diff === b.diff && a.fetched === b.fetched,
        (_path, key) => {
          const merged = mergeContextLines(key.diff.hunks, key.fetched);
          return key.diff.hunks.map((hunk, hunkIndex) => ({
            ...hunk,
            lines: [...merged[hunkIndex].prepend, ...hunk.lines, ...merged[hunkIndex].append],
          }));
        },
      ),
    [diffByPath, contextFetchedByPath],
  );

  // Only highlight hunks that actually have rendered rows: lines inside a collapsed
  // moved/whitespace hunk aren't shown at all until expanded, so there's no reason to pay for
  // tokenizing them up front — especially on a large file, where that eager work can jank the
  // main thread.
  const hunkTokensByPath = useMemo(
    () =>
      incrementalPerPath(
        hunkTokensCacheRef,
        effectiveHunksByPath.keys(),
        (path) => {
          const hunks = effectiveHunksByPath.get(path);
          return hunks ? { hunks, expandedHunks: expandedHunksByPath[path] ?? EMPTY_HUNK_SET } : null;
        },
        (a, b) => a.hunks === b.hunks && a.expandedHunks === b.expandedHunks,
        (path, key) =>
          key.hunks.map((hunk, hunkIndex) => {
            const collapsible = hunk.pureMove || hunk.whitespaceOnly;
            if (collapsible && !key.expandedHunks.has(hunkIndex)) return [];
            return highlightHunk(hunk, path);
          }),
      ),
    [effectiveHunksByPath, expandedHunksByPath],
  );

  // Word-level (intra-line) emphasis spans, same per-hunk gating and caching as the tokens above.
  const hunkIntralineByPath = useMemo(
    () =>
      incrementalPerPath(
        hunkIntralineCacheRef,
        effectiveHunksByPath.keys(),
        (path) => {
          const hunks = effectiveHunksByPath.get(path);
          return hunks ? { hunks, expandedHunks: expandedHunksByPath[path] ?? EMPTY_HUNK_SET } : null;
        },
        (a, b) => a.hunks === b.hunks && a.expandedHunks === b.expandedHunks,
        (_path, key) =>
          key.hunks.map((hunk, hunkIndex) => {
            const collapsible = hunk.pureMove || hunk.whitespaceOnly;
            if (collapsible && !key.expandedHunks.has(hunkIndex)) return [];
            return computeIntralineForHunk(hunk);
          }),
      ),
    [effectiveHunksByPath, expandedHunksByPath],
  );

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
          totalLines: diffEntry?.diff?.totalLines ?? null,
          contextLines: contextFetchedByPath[file.path] ?? EMPTY_CONTEXT_MAP,
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
      contextFetchedByPath,
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

  // Resolved lazily from `cursorKey` rather than stored directly: `rows` rebuilds on collapse/
  // expand, context fetches, a refresh, etc., shifting every row's index, so a raw stored index
  // would end up pointing at an unrelated row. `null` here (not found, e.g. the cursor's file just
  // collapsed) naturally clears the accent border rather than drawing it on the wrong row.
  const cursorIndex = useMemo(() => {
    if (cursorKey === null) return null;
    const index = rows.findIndex((row) => row.key === cursorKey);
    return index === -1 ? null : index;
  }, [rows, cursorKey]);

  // Prefetch the next unviewed file's diff as soon as a file expands, so paging through the
  // module in reading order rarely shows a loading row. `staleTime` and the cache check keep a
  // steady module (nothing newly expanded) from re-issuing the same prefetch every render.
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
      const queryKey = ["prr.fileDiff", repo, number, next.path, scope] as const;
      if (queryClient.getQueryData(queryKey) !== undefined) return;
      void queryClient.prefetchQuery({ queryKey, queryFn: () => fileDiffFetcher({ repo, number, path: next.path, scope }), staleTime: 60_000 });
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
      toast.error("That file is hidden by the current filter");
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

  // Scroll metrics feed the minimap only; keep them in a ref for anything that doesn't need a
  // re-render, and only commit to state (triggering one) when the minimap is actually mounted and
  // the offset moved enough to matter — otherwise every 16ms scroll tick would re-render the
  // whole tab, including every currently-visible row.
  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    if (props.layout.compact) return; // the minimap isn't rendered, so there's nothing to feed
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const next: MinimapScrollMetrics = { offset: contentOffset.y, viewportHeight: layoutMeasurement.height, contentHeight: contentSize.height };
    setScrollMetrics((prev) =>
      prev && Math.abs(prev.offset - next.offset) < 8 && prev.viewportHeight === next.viewportHeight && prev.contentHeight === next.contentHeight
        ? prev
        : next,
    );
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

  const visibleUnviewedFiles = useMemo(
    () => visibleFiles.filter((file) => (viewedOverride[file.path] ?? file.viewed) !== "VIEWED"),
    [visibleFiles, viewedOverride],
  );

  /** Marks every currently-unviewed *visible* file viewed: optimistic up front for all of them,
   * the RPCs run concurrently (`allSettled`, not one at a time), and failures revert just their
   * own file instead of leaving the whole batch unresolved. */
  async function markModuleViewed() {
    const unviewed = visibleUnviewedFiles;
    if (unviewed.length === 0) return;
    const previousByPath = new Map(unviewed.map((file) => [file.path, viewedOverride[file.path]]));
    setViewedOverride((prev) => {
      const next = { ...prev };
      unviewed.forEach((file) => {
        next[file.path] = "VIEWED";
      });
      return next;
    });
    const results = await Promise.allSettled(unviewed.map((file) => viewedRpcCall({ repo, number, path: file.path, viewed: true })));
    setViewedOverride((prev) => {
      const next = { ...prev };
      results.forEach((result, index) => {
        const file = unviewed[index];
        if (result.status === "fulfilled") {
          next[file.path] = result.value.viewed;
        } else {
          const previous = previousByPath.get(file.path);
          if (previous === undefined) delete next[file.path];
          else next[file.path] = previous;
        }
      });
      return next;
    });
    const failedCount = results.filter((result) => result.status === "rejected").length;
    if (failedCount > 0) toast.error(`Failed to mark ${failedCount} file${failedCount === 1 ? "" : "s"} viewed`);
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

  /** Handles both "Expand N lines" (one `CONTEXT_PAGE_SIZE` page, nearest the neighboring hunk)
   * and "Expand all" (the whole remaining gap in one call, only offered when the gap's full size
   * is within `prr.file.lines`'s 500-line cap). "above" fills backward from the hunk's first
   * line toward the file's start; "between"/"below" fill forward from the previous hunk/EOF. */
  function expandContext(path: string, position: ContextGapPosition, hunkIndex: number, mode: "press" | "all") {
    const diff = diffByPath.get(path)?.diff;
    if (!diff) return;
    const gap = gapsForFile(diff.hunks, diff.totalLines, diff.truncated).find((g) => g.position === position && g.hunkIndex === hunkIndex);
    if (!gap || gap.unsafe) return; // unsafe gaps offer no expand action (see DiffRows' renderer)
    const fetchedMap = contextFetchedByPath[path] ?? EMPTY_CONTEXT_MAP;
    const already = countFetchedInGap(fetchedMap, gap);
    const remaining = gap.count - already;
    if (remaining <= 0) return;
    const take = mode === "all" ? remaining : Math.min(CONTEXT_PAGE_SIZE, remaining);
    let start: number;
    let end: number;
    if (position === "above") {
      end = gap.newStart + gap.count - 1 - already;
      start = end - take + 1;
    } else {
      start = gap.newStart + already;
      end = start + take - 1;
    }
    const busyKey = `${path}:${position}:${hunkIndex}`;
    setContextPending((prev) => new Set(prev).add(busyKey));
    // Captured at request time: if a push lands (and `headSha` changes, resetting
    // `contextFetchedByPath`) before this resolves, `headShaRef.current` will have moved on and
    // the result below is discarded instead of re-populating state with now-stale line numbers.
    const requestSha = headSha;
    fileLinesFetcher({ repo, number, path, side: "head", start, end })
      .then((result) => {
        if (headShaRef.current !== requestSha) return;
        setContextFetchedByPath((prev) => {
          const next = { ...prev };
          const map = new Map(next[path] ?? []);
          result.lines.forEach((text, i) => map.set(start + i, text));
          next[path] = map;
          return next;
        });
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Failed to expand context");
      })
      .finally(() => {
        setContextPending((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
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
    return effectiveHunksByPath.get(path)?.[hunkIndex];
  }
  function getTokens(path: string, hunkIndex: number): HighlightToken[][] {
    return hunkTokensByPath.get(path)?.[hunkIndex] ?? [];
  }
  function getIntraline(path: string, hunkIndex: number): Array<Span[] | null> {
    return hunkIntralineByPath.get(path)?.[hunkIndex] ?? [];
  }
  function getDraft(path: string, draftId: number): DraftComment | undefined {
    return draftsByPath.get(path)?.find((draft) => draft.id === draftId);
  }

  function isFileViewed(path: string): boolean {
    const file = visibleFiles.find((candidate) => candidate.path === path);
    return file ? (viewedOverride[file.path] ?? file.viewed) === "VIEWED" : false;
  }

  function clearHoverGutter(key: string) {
    setHoverKey((prev) => (prev === key ? null : prev));
  }
  function clearHoverRow(key: string) {
    setHoveredRowKey((prev) => (prev === key ? null : prev));
  }

  // --- Keyboard navigation (web only) --------------------------------------------------------

  function markKeyboardNav() {
    keyboardNavUntilRef.current = Date.now() + KEYBOARD_NAV_SETTLE_MS;
  }

  function requestScroll(index: number, viewPosition: number) {
    listRef.current?.scrollToIndex({ index, viewPosition, animated: true });
  }

  /** Only scrolls when `index` isn't already within the last-reported viewable range, so landing
   * the cursor on an already-visible row doesn't jump the list around it. */
  function scrollIntoViewIfNeeded(index: number) {
    const range = viewableRangeRef.current;
    if (index >= range.min && index <= range.max) return;
    requestScroll(index, 0.5);
  }

  function goToFile(direction: NavDirection): boolean {
    const headerIndex = nextFileIndex(rows, currentPath, direction);
    if (headerIndex === null) return false;
    const row = rows[headerIndex];
    if (row.type !== "fileHeader") return false;
    markKeyboardNav();
    if (expanded[row.path] !== true) setExpanded((prev) => ({ ...prev, [row.path]: true }));
    setCurrentPath(row.path);
    setCursorKey(null);
    requestScroll(headerIndex, 0);
    return true;
  }

  function toggleExpandCurrent(): boolean {
    if (currentPath === null) return false;
    toggleExpand(currentPath);
    return true;
  }

  /** Marks `file` viewed and moves to the next not-fully-viewed file in reading order — used by
   * both the `v` key and each file header's "Viewed & next" button. Computes "next" against the
   * optimistic viewed state (treating `file` itself as already VIEWED), not the raw (possibly
   * stale) analysis flag, so it doesn't re-offer the file just marked. Delegates the actual
   * expand-and-scroll to `props.focusPath` (the same mechanism "Next unviewed" and the outline
   * use) rather than scrolling to a `fileHeader` index computed before the current file's own
   * collapse (triggered just above) has rebuilt `rows` — that stale index would point at
   * whatever row happens to be there after the collapse, not the intended next file. */
  function markViewedAndNext(file: AnalyzedFile): void {
    void toggleViewed(file, true);
    setExpanded((prev) => ({ ...prev, [file.path]: false }));
    const candidates = visibleFiles.map((candidate) => ({
      path: candidate.path,
      viewed: candidate.path === file.path ? ("VIEWED" as ViewedState) : viewedOverride[candidate.path] ?? candidate.viewed,
      order: candidate.order,
    }));
    const next = nextUnviewedPath(candidates, file.path, readingOrder);
    if (!next) return;
    props.setFocusPath(next);
  }

  function markCurrentViewedAndNext(): boolean {
    if (currentPath === null) return false;
    const file = visibleFiles.find((candidate) => candidate.path === currentPath);
    if (!file) return false;
    markViewedAndNext(file);
    return true;
  }

  function jumpHunk(direction: NavDirection): boolean {
    const index = nextHunkIndex(rows, cursorIndex, direction);
    if (index === null) return false;
    const row = rows[index];
    markKeyboardNav();
    setCursorKey(row.key);
    if (row.path) setCurrentPath(row.path);
    scrollIntoViewIfNeeded(index);
    return true;
  }

  /** `n`: jumps to the next open thread or failing (non-dismissed) finding. `nextUnresolvedIndex`
   * only sees rows that actually exist, i.e. only *expanded* files — when it comes up empty, that
   * means nothing unresolved is visible right now, not that nothing unresolved exists; fall back
   * to searching every visible file (expanded or not) and, if one has an unresolved item, expand
   * it and remember it as the pending target so the cursor can land on it once its rows exist
   * (its diff may still need to load — see the effect below). */
  function jumpToUnresolved(): boolean {
    const index = nextUnresolvedIndex(rows, cursorIndex);
    if (index !== null) {
      const row = rows[index];
      markKeyboardNav();
      setCursorKey(row.key);
      if (row.path) setCurrentPath(row.path);
      requestScroll(index, 0.5); // always scroll: `n` should never look like a no-op
      return true;
    }
    const nextPath = nextFileWithUnresolved(visibleFiles, threadsByPath, findingsByPath, currentPath);
    if (!nextPath) return false;
    markKeyboardNav();
    pendingUnresolvedTargetRef.current = nextPath;
    setCurrentPath(nextPath);
    if (expanded[nextPath] !== true) setExpanded((prev) => ({ ...prev, [nextPath]: true }));
    return true;
  }

  function moveCursorDir(direction: NavDirection): boolean {
    const index = moveCursor(rows, cursorIndex, direction);
    if (index === null) return false;
    const row = rows[index];
    markKeyboardNav();
    setCursorKey(row.key);
    if (row.path) setCurrentPath(row.path);
    scrollIntoViewIfNeeded(index);
    return true;
  }

  function openComposerAtCursor(): boolean {
    if (cursorIndex === null) return false;
    const row = rows[cursorIndex];
    if (!row) return false;
    if (row.type === "line") {
      const hunk = getHunk(row.path, row.hunkIndex);
      const line = hunk?.lines[row.lineIndex];
      if (!line) return false;
      if (line.newNo !== null) openComposer(row.path, "RIGHT", line.newNo);
      else if (line.oldNo !== null) openComposer(row.path, "LEFT", line.oldNo);
      else return false;
      return true;
    } else if (row.type === "pair") {
      const hunk = getHunk(row.path, row.hunkIndex);
      if (!hunk) return false;
      const newLine = row.newIndex !== null ? hunk.lines[row.newIndex] : null;
      if (newLine && newLine.newNo !== null) {
        openComposer(row.path, "RIGHT", newLine.newNo);
        return true;
      }
      const oldLine = row.oldIndex !== null ? hunk.lines[row.oldIndex] : null;
      if (oldLine && oldLine.oldNo !== null) {
        openComposer(row.path, "LEFT", oldLine.oldNo);
        return true;
      }
    }
    return false;
  }

  function toggleShortcuts(): boolean {
    setShortcutSheetOpen((open) => !open);
    return true;
  }

  // Everything the keydown handler needs, refreshed every render so the listener (registered
  // once below) never reads stale `rows`/`cursorIndex`/`composer` or a stale closure over them.
  const keyboardRef = useRef({
    composerOpen: composer !== null,
    goToFile,
    toggleExpandCurrent,
    markCurrentViewedAndNext,
    jumpHunk,
    jumpToUnresolved,
    moveCursorDir,
    openComposerAtCursor,
    toggleShortcuts,
  });
  keyboardRef.current = {
    composerOpen: composer !== null,
    goToFile,
    toggleExpandCurrent,
    markCurrentViewedAndNext,
    jumpHunk,
    jumpToUnresolved,
    moveCursorDir,
    openComposerAtCursor,
    toggleShortcuts,
  };

  // Resolves a pending `n` jump into a file that had to be expanded first (see `jumpToUnresolved`
  // above): once that file's rows include an unresolved thread/finding — its diff may still be
  // loading, so this can take a few `rows` rebuilds — land the cursor there and scroll it into
  // view. A target whose header isn't in `rows` yet, or whose unresolved item hasn't rendered
  // yet, is left pending for the next rebuild.
  useEffect(() => {
    const target = pendingUnresolvedTargetRef.current;
    if (!target) return;
    const headerIndex = rows.findIndex((row) => row.type === "fileHeader" && row.path === target);
    if (headerIndex === -1) return;
    const index = nextUnresolvedIndex(rows, headerIndex);
    if (index === null) return;
    pendingUnresolvedTargetRef.current = null;
    const row = rows[index];
    markKeyboardNav();
    setCursorKey(row.key);
    if (row.path) setCurrentPath(row.path);
    requestScroll(index, 0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  useEffect(() => {
    if (props.layout.platform !== "web") return;
    const doc = (globalThis as any).document;
    if (!doc?.addEventListener) return;

    function handleKeyDown(event: DomKeyboardEvent) {
      const actions = keyboardRef.current;
      const tag = event.target?.tagName ? event.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (actions.composerOpen) return; // Escape included: the composer's own input handles it.
      let consumed: boolean;
      switch (event.key) {
        case "j":
          consumed = actions.goToFile(1);
          break;
        case "k":
          consumed = actions.goToFile(-1);
          break;
        case "e":
          consumed = actions.toggleExpandCurrent();
          break;
        case "v":
          consumed = actions.markCurrentViewedAndNext();
          break;
        case "n":
          consumed = actions.jumpToUnresolved();
          break;
        case "[":
          consumed = actions.jumpHunk(-1);
          break;
        case "]":
          consumed = actions.jumpHunk(1);
          break;
        case "ArrowDown":
          consumed = actions.moveCursorDir(1);
          break;
        case "ArrowUp":
          consumed = actions.moveCursorDir(-1);
          break;
        case "c":
          consumed = actions.openComposerAtCursor();
          break;
        case "?":
          consumed = actions.toggleShortcuts();
          break;
        default:
          return;
      }
      // Only swallow the key when it actually moved/acted on something — otherwise, e.g.
      // ArrowUp/ArrowDown at the start/end of the code rows would disable native list scrolling
      // for no reason.
      if (consumed) event.preventDefault();
    }

    doc.addEventListener("keydown", handleKeyDown);
    return () => doc.removeEventListener("keydown", handleKeyDown);
    // Registered once per platform value: the handler reads everything through `keyboardRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layout.platform]);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null; item: Row }> }) => {
    const indices = info.viewableItems.map((v) => v.index).filter((i): i is number => i !== null);
    if (indices.length > 0) viewableRangeRef.current = { min: Math.min(...indices), max: Math.max(...indices) };
    if (Date.now() < keyboardNavUntilRef.current) return; // a keyboard scroll is still settling
    const first = info.viewableItems.find((v) => v.item.path);
    if (first) setCurrentPath(first.item.path);
  }).current;

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
    getIntraline,
    getDraft,
    cursorIndex,
    currentPath,
    onToggleViewed: (file) => void toggleViewed(file, (viewedOverride[file.path] ?? file.viewed) !== "VIEWED"),
    onMarkViewedAndNext: markViewedAndNext,
    onToggleExpand: toggleExpand,
    onOpenMove: (path) => setMovingPath(path),
    onToggleOutline: toggleOutline,
    onSelectOutlineEntry: selectOutlineEntry,
    onRevealSinceViewed: revealSinceViewed,
    onSetViewMode: setViewModeFor,
    viewModeOf: (path) => viewModeByPath.get(path) ?? "text",
    onExpandHunk: expandHunk,
    contextPending,
    onExpandContext: expandContext,
    hoverKey,
    onHoverGutter: setHoverKey,
    onHoverGutterOut: clearHoverGutter,
    hoveredRowKey,
    onHoverRow: setHoveredRowKey,
    onHoverRowOut: clearHoverRow,
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

  // `ctx` is a fresh object every render (it carries ~30 live callbacks), so a `useCallback(fn,
  // [ctx])` wrapper around `renderItem` would never actually stay stable — it'd rebuild on every
  // render just like an inline function would. Reading `ctx` from a ref instead keeps `renderItem`
  // itself permanently stable (so FlatList never treats it as "changed"), while `StreamRowItem`'s
  // own memo comparator (`rowPropsEqual`) remains the real guard against unnecessary row re-renders.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const renderItem = useCallback(
    ({ item, index }: { item: Row; index: number }) => <StreamRowItem row={item} index={index} ctx={ctxRef.current} />,
    [],
  );

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
          {visibleUnviewedFiles.length > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => void markModuleViewed()} style={surfaces(c).buttonQuiet}>
              <Text style={surfaces(c).buttonQuietText}>
                Mark {visibleUnviewedFiles.length} visible file{visibleUnviewedFiles.length === 1 ? "" : "s"} viewed
              </Text>
            </Pressable>
          ) : null}
          {props.layout.platform === "web" ? (
            <Pressable accessibilityRole="button" onPress={toggleShortcuts}>
              <Text style={{ ...font.caption, color: c.accent }}>Keyboard shortcuts (?)</Text>
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
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
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

      <Modal title="Keyboard shortcuts" open={shortcutSheetOpen} onOpenChange={(open) => !open && setShortcutSheetOpen(false)}>
        <Modal.Content>
          <View style={{ gap: space.sm }}>
            {SHORTCUTS.map((shortcut) => (
              <View key={shortcut.key} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Text style={{ ...font.small, fontWeight: "600", color: c.foreground, width: 72 }}>{shortcut.key}</Text>
                <Text style={{ ...font.small, color: c.foregroundMuted, flex: 1 }}>{shortcut.label}</Text>
              </View>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
