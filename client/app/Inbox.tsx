import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useInbox, useRepos } from "../data/hooks";
import type { InboxSection, PrSummary } from "../../shared/types";
import type { InboxFilters, RecentPr } from "../../shared/ui-state";
import { rememberInboxFilters, useInboxFilters, useRecentPrs } from "./ui-state";
import { agoLabel, relativeAge } from "../ui/time";
import { font, radius, space, surfaces } from "../ui/tokens";
import { Dot } from "../ui/chips";
import { EmptyState, ErrorState, InlineLoading, Skeleton } from "../ui/states";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type ReviewDecision = PrSummary["reviewDecision"];

type SortKey = InboxFilters["sort"];
type CiFilter = InboxFilters["ci"];
type ReviewFilter = InboxFilters["review"];

/** "Needs you" is synthesized client-side (not part of the server's `InboxSection` enum), so the
 * row/header model works over this superset instead of `InboxSection` directly. */
type ClientSection = InboxSection | "needs_you";

const SECTION_ORDER: ClientSection[] = ["needs_you", "recent", "mine", "review_requested", "assigned", "all"];
const SECTION_LABELS: Record<ClientSection, string> = {
  needs_you: "Needs you",
  recent: "Recently reviewed",
  mine: "My PRs",
  review_requested: "Review requested",
  assigned: "Assigned",
  all: "All open",
};

type Row =
  | { kind: "header"; section: ClientSection; count: number; first: boolean }
  | { kind: "pr"; key: string; pr: PrSummary }
  /** A PR opened in this app that no inbox search returned (e.g. merged long ago): title only. */
  | { kind: "recentLite"; key: string; recent: RecentPr };

const STATE_LABEL: Record<PrSummary["state"], string> = { OPEN: "", CLOSED: "Closed", MERGED: "Merged" };

function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

const REVIEW_LABEL: Record<ReviewDecision, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
  NONE: "",
};

/** A PR needs the viewer's attention: a review was explicitly requested, the diff moved since
 * their last review, or they're assigned to an open PR they haven't already requested changes on. */
function isNeedsYou(pr: PrSummary): boolean {
  if (pr.state !== "OPEN") return false;
  if (pr.sections.includes("review_requested")) return true;
  if (pr.changedSinceMyReview !== null && pr.changedSinceMyReview > 0) return true;
  if (pr.sections.includes("assigned") && pr.reviewDecision !== "CHANGES_REQUESTED" && pr.state === "OPEN") return true;
  return false;
}

/** Changed-since-your-review first, then review-requested, then the rest — each group by `updatedAt`. */
function needsYouRank(pr: PrSummary): number {
  if (pr.changedSinceMyReview !== null && pr.changedSinceMyReview > 0) return 0;
  if (pr.sections.includes("review_requested")) return 1;
  return 2;
}

function sortNeedsYou(items: PrSummary[]): PrSummary[] {
  return [...items].sort((a, b) => {
    const rankDiff = needsYouRank(a) - needsYouRank(b);
    return rankDiff !== 0 ? rankDiff : b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * A pressable filter/sort pill (distinct from `client/ui/chips.tsx`'s `Chip`, which is a
 * non-interactive status badge). Module-scope so it isn't redefined — and every instance
 * remounted — on every `Inbox` render.
 */
function FilterChip({ label, active, onPress, c }: { label: string; active: boolean; onPress(): void; c: ThemeColors }) {
  const s = surfaces(c);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.pill(active)}>
      <Text style={s.pillText(active)}>{label}</Text>
    </Pressable>
  );
}

/** 20px author avatar; falls back to the author's first letter on a tinted circle when there's no
 * `authorAvatarUrl` (or it fails to load). Module-scope for the same reason as `FilterChip`. */
function Avatar({ url, name, c }: { url: string | null; name: string; c: ThemeColors }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <Image
        source={{ uri: url }}
        accessibilityLabel={name}
        onError={() => setFailed(true)}
        style={{ width: 20, height: 20, borderRadius: 10 }}
      />
    );
  }
  return (
    <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

/** Generic filter field backed by `InboxFilters`: seeds its initial value from the persisted
 * filters and persists (`rememberInboxFilters`) on every change, while still behaving like a
 * normal `useState` setter (accepts a value or an updater) for existing call sites. Resolves
 * updater functions against a ref (not inside the `setValue` updater) so `rememberInboxFilters` —
 * a side effect — runs exactly once per change instead of risking a double-invoke under a
 * future Strict Mode reducer check. */
function useRememberedFilter<K extends keyof InboxFilters>(
  key: K,
  initial: InboxFilters[K],
): [InboxFilters[K], (updater: InboxFilters[K] | ((cur: InboxFilters[K]) => InboxFilters[K])) => void] {
  const [value, setValue] = useState<InboxFilters[K]>(initial);
  const valueRef = useRef(value);
  valueRef.current = value;
  function set(updater: InboxFilters[K] | ((cur: InboxFilters[K]) => InboxFilters[K])) {
    const next = typeof updater === "function" ? (updater as (c: InboxFilters[K]) => InboxFilters[K])(valueRef.current) : updater;
    valueRef.current = next;
    setValue(next);
    rememberInboxFilters({ [key]: next } as Partial<InboxFilters>);
  }
  return [value, set];
}

export function Inbox({
  theme,
  layout,
  onOpenPr,
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  onOpenPr(ref: { repo: string; number: number; title?: string }): void;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  const inbox = useInbox();
  const repos = useRepos();
  const recentLocal = useRecentPrs();
  const inboxFilters = useInboxFilters();
  const [collapsed, setCollapsed] = useState<Partial<Record<ClientSection, boolean>>>({});
  const [search, setSearch] = useState(""); // not persisted, per spec
  const [repoFilter, setRepoFilter] = useRememberedFilter("repo", inboxFilters.repo);
  const [hideDrafts, setHideDrafts] = useRememberedFilter("hideDrafts", inboxFilters.hideDrafts);
  const [ciFilter, setCiFilter] = useRememberedFilter("ci", inboxFilters.ci);
  const [reviewFilter, setReviewFilter] = useRememberedFilter("review", inboxFilters.review);
  const [sort, setSort] = useRememberedFilter("sort", inboxFilters.sort);

  // A remembered repo filter for a repo that is no longer a Paseo project would hide every PR
  // with no visible chip to clear it; drop it once the repo list is known.
  useEffect(() => {
    const known = repos.data?.repos;
    if (!known || !repoFilter) return;
    if (!known.some((repo) => repo.slug === repoFilter)) setRepoFilter(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.data, repoFilter]);
  const [errorsDismissed, setErrorsDismissed] = useState(false);
  const searchInputRef = useRef<TextInput>(null);

  // Web only: focus search on `/` unless the user is already typing somewhere.
  useEffect(() => {
    if (layout.platform !== "web") return;
    const doc = (globalThis as any).document;
    if (!doc?.addEventListener) return;
    function handleKeyDown(event: any) {
      if (event.key !== "/") return;
      const target = event.target;
      const tag = typeof target?.tagName === "string" ? target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      event.preventDefault?.();
      searchInputRef.current?.focus();
    }
    doc.addEventListener("keydown", handleKeyDown);
    return () => doc.removeEventListener("keydown", handleKeyDown);
  }, [layout.platform]);

  const prs = inbox.data?.prs ?? [];
  const errors = inbox.data?.errors ?? [];
  // `inbox.data?.refreshing` is the server's background revalidation of a stale snapshot;
  // `inbox.refreshing` is this client's own forced refresh (the refresh button). Either one
  // means "the list on screen may be about to change."
  const isRefreshing = inbox.refreshing || !!inbox.data?.refreshing;
  const haveAttention = prs.some((pr) => pr.attention !== null);
  const effectiveSort: SortKey = sort === "attention" && !haveAttention ? "updated" : sort;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prs.filter((pr) => {
      if (repoFilter && pr.repo !== repoFilter) return false;
      if (hideDrafts && pr.isDraft) return false;
      if (ciFilter === "failing" && pr.checks !== "failure") return false;
      if (ciFilter === "passing" && pr.checks !== "success") return false;
      if (reviewFilter !== "any" && pr.reviewDecision !== reviewFilter) return false;
      if (q) {
        const haystack = `${pr.title} ${pr.author} ${pr.repo} #${pr.number}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [prs, search, repoFilter, hideDrafts, ciFilter, reviewFilter]);

  // Per-section rows, independent of collapse state (so toggling a section's collapse doesn't
  // re-run filtering/sorting for every other section).
  const sectionsData = useMemo(() => {
    function sortPrs(items: PrSummary[]): PrSummary[] {
      const sorted = [...items];
      sorted.sort((a, b) => {
        switch (effectiveSort) {
          case "attention":
            return (b.attention ?? -1) - (a.attention ?? -1);
          case "created":
            return b.createdAt.localeCompare(a.createdAt);
          case "size":
            return b.additions + b.deletions - (a.additions + a.deletions);
          case "severity":
            return (b.severity ?? -1) - (a.severity ?? -1);
          case "updated":
          default:
            return b.updatedAt.localeCompare(a.updatedAt);
        }
      });
      return sorted;
    }

    const result: Array<{ section: ClientSection; items: Row[] }> = [];

    for (const section of SECTION_ORDER) {
      if (section === "needs_you") {
        const items = sortNeedsYou(filtered.filter(isNeedsYou)).map((pr) => ({
          kind: "pr" as const,
          key: `needs_you:${prKey(pr.repo, pr.number)}`,
          pr,
        }));
        result.push({ section, items });
        continue;
      }
      if (section === "recent") {
        // PRs reviewed from this app, most recent first (full rows when a search returned the
        // PR), then whatever else GitHub says you reviewed. Merely opening a PR doesn't count.
        const byKey = new Map(filtered.map((pr) => [prKey(pr.repo, pr.number), pr]));
        const seen = new Set<string>();
        const items: Row[] = [];
        for (const recent of recentLocal) {
          const key = prKey(recent.repo, recent.number);
          if (seen.has(key)) continue;
          const pr = byKey.get(key);
          if (!recent.reviewedAt && !pr?.sections.includes("recent")) continue;
          if (pr) {
            seen.add(key);
            items.push({ kind: "pr", key: `recent:${key}`, pr });
            continue;
          }
          if (repoFilter && recent.repo !== repoFilter) continue;
          const q = search.trim().toLowerCase();
          if (q && !`${recent.title} ${recent.repo} #${recent.number}`.toLowerCase().includes(q)) continue;
          seen.add(key);
          items.push({ kind: "recentLite", key: `recent-lite:${key}`, recent });
        }
        for (const pr of sortPrs(filtered.filter((pr) => pr.sections.includes("recent")))) {
          const key = prKey(pr.repo, pr.number);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ kind: "pr", key: `recent:${key}`, pr });
        }
        result.push({ section, items });
        continue;
      }
      const inSection = sortPrs(filtered.filter((pr) => pr.sections.includes(section)));
      result.push({
        section,
        items: inSection.map((pr) => ({ kind: "pr" as const, key: `${section}:${pr.repo}#${pr.number}`, pr })),
      });
    }
    return result;
  }, [filtered, effectiveSort, recentLocal, repoFilter, search]);

  const totalPrRows = useMemo(() => sectionsData.reduce((n, section) => n + section.items.length, 0), [sectionsData]);

  // Sections with zero rows aren't rendered at all; non-empty sections keep their collapse state.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const { section, items } of sectionsData) {
      if (items.length === 0) continue;
      out.push({ kind: "header", section, count: items.length, first: out.length === 0 });
      if (!collapsed[section]) out.push(...items);
    }
    return out;
  }, [sectionsData, collapsed]);

  const sortLabels: Record<SortKey, string> = {
    attention: "Sort: Attention",
    updated: "Sort: Updated",
    created: "Sort: Created",
    size: "Sort: Size",
    severity: "Sort: Severity",
  };
  const sortOrder: SortKey[] = ["attention", "updated", "created", "size", "severity"];

  if (repos.data && repos.data.repos.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, justifyContent: "center" }}>
        <EmptyState
          theme={theme}
          title="No repos yet"
          hint="PR Review pulls pull requests from repos already added to Paseo as projects with a github.com remote. Add a repo as a Paseo project to see its PRs here."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      {!errorsDismissed && errors.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm + 2, backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border }}>
          <Text style={{ flex: 1, ...font.caption, color: c.statusDanger }}>{errors.join(" · ")}</Text>
          <Pressable accessibilityRole="button" onPress={() => setErrorsDismissed(true)}>
            <Icon name="X" size={14} color={c.foregroundMuted} />
          </Pressable>
        </View>
      )}
      <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name="Search" size={14} color={c.foregroundMuted} />
            <TextInput
              ref={searchInputRef}
              value={search}
              onChangeText={setSearch}
              placeholder="Search title, author, repo, #number"
              placeholderTextColor={c.foregroundMuted}
              style={{ ...s.input, flex: 1 }}
            />
          </View>
          {inbox.data && (
            <Text style={{ ...font.caption, color: c.foregroundMuted }}>Updated {agoLabel(inbox.data.fetchedAt)}</Text>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => inbox.refresh()}
            style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, backgroundColor: c.surface2 }}
          >
            <Icon name="RefreshCw" size={14} color={c.foreground} />
          </Pressable>
        </View>
        {isRefreshing && <InlineLoading theme={theme} label="Refreshing…" />}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
          {(repos.data?.repos ?? []).map((repo) => (
            <FilterChip c={c} key={repo.slug} label={repo.slug} active={repoFilter === repo.slug} onPress={() => setRepoFilter((cur) => (cur === repo.slug ? null : repo.slug))} />
          ))}
          <FilterChip c={c} label={hideDrafts ? "Drafts hidden" : "Hide drafts"} active={hideDrafts} onPress={() => setHideDrafts((v) => !v)} />
          <FilterChip c={c}
            label={ciFilter === "any" ? "CI: any" : ciFilter === "failing" ? "CI: failing" : "CI: passing"}
            active={ciFilter !== "any"}
            onPress={() => setCiFilter((cur) => (cur === "any" ? "failing" : cur === "failing" ? "passing" : "any"))}
          />
          <FilterChip c={c}
            label={reviewFilter === "any" ? "Review: any" : REVIEW_LABEL[reviewFilter] || "Review: any"}
            active={reviewFilter !== "any"}
            onPress={() =>
              setReviewFilter((cur) => {
                const order: ReviewFilter[] = ["any", "REVIEW_REQUIRED", "CHANGES_REQUESTED", "APPROVED"];
                return order[(order.indexOf(cur) + 1) % order.length];
              })
            }
          />
          <FilterChip c={c}
            label={sortLabels[sort]}
            active={false}
            onPress={() => setSort((cur) => sortOrder[(sortOrder.indexOf(cur) + 1) % sortOrder.length])}
          />
        </View>
      </View>

      {inbox.isPending ? (
        <Skeleton theme={theme} rows={6} lineHeight={64} widths={["100%", "100%", "100%", "100%", "100%", "100%"]} />
      ) : inbox.isError ? (
        <ErrorState theme={theme} message="Could not load the inbox." onRetry={() => inbox.refresh()} />
      ) : totalPrRows === 0 && prs.length === 0 ? (
        <EmptyState
          theme={theme}
          title="No pull requests"
          hint="PR Review pulls pull requests from repos already added to Paseo as projects with a github.com remote. Add a repo as a Paseo project to see its PRs here."
        />
      ) : totalPrRows === 0 ? (
        <EmptyState
          theme={theme}
          icon="Filter"
          title="No pull requests match"
          hint="Your search or filters hide every open PR."
          actionLabel="Clear filters"
          onAction={() => {
            setSearch("");
            setRepoFilter(() => null);
            setHideDrafts(() => false);
            setCiFilter(() => "any");
            setReviewFilter(() => "any");
          }}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row: Row) => (row.kind === "header" ? `h:${row.section}` : row.key)}
          contentContainerStyle={{ padding: space.md, gap: space.sm + 2 }}
          renderItem={({ item }: { item: Row }) => {
            if (item.kind === "header") {
              const isCollapsed = !!collapsed[item.section];
              return (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCollapsed((cur) => ({ ...cur, [item.section]: !cur[item.section] }))}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingVertical: space.sm + 2,
                    marginTop: item.first ? 0 : space.xs + 2,
                  }}
                >
                  <Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} size={14} color={c.foregroundMuted} />
                  {item.section === "needs_you" && <Dot color={c.accent} size={6} />}
                  <Text style={{ ...font.title, color: c.foreground }}>
                    {SECTION_LABELS[item.section]}{" "}
                    <Text style={{ ...font.title, fontWeight: "400", color: c.foregroundMuted }}>({item.count})</Text>
                  </Text>
                </Pressable>
              );
            }
            if (item.kind === "recentLite") {
              const recent = item.recent;
              return (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpenPr({ repo: recent.repo, number: recent.number, title: recent.title })}
                  style={({ pressed }) => ({ ...s.card, backgroundColor: pressed ? c.surface2 : c.surface1, gap: space.xs + 2 })}
                >
                  <Text numberOfLines={2} style={{ ...font.bodyLg, fontWeight: "600", color: c.foreground }}>
                    {recent.title}
                  </Text>
                  <Text style={{ ...font.small, color: c.foregroundMuted }}>
                    {recent.repo}#{recent.number} · opened {agoLabel(recent.openedAt)}
                    {recent.reviewedAt ? ` · reviewed ${agoLabel(recent.reviewedAt)}` : ""}
                  </Text>
                </Pressable>
              );
            }
            const pr = item.pr;
            const ciColor =
              pr.checks === "success" ? c.statusSuccess : pr.checks === "failure" ? c.statusDanger : pr.checks === "pending" ? c.statusWarning : c.foregroundMuted;
            const extraLabels = Math.max(0, pr.labels.length - 3);
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => onOpenPr({ repo: pr.repo, number: pr.number, title: pr.title })}
                style={({ pressed }) => ({ ...s.card, backgroundColor: pressed ? c.surface2 : c.surface1, gap: space.xs + 2 })}
              >
                <Text numberOfLines={2} style={{ ...font.bodyLg, fontWeight: "600", color: c.foreground }}>
                  {pr.title}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Avatar url={pr.authorAvatarUrl} name={pr.author} c={c} />
                  <Text style={{ ...font.small, color: c.foregroundMuted }}>
                    {pr.repo}#{pr.number} · {pr.author} · {relativeAge(pr.updatedAt)}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  {pr.isDraft && (
                    <Text style={{ ...font.caption, color: c.foregroundMuted, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 5 }}>Draft</Text>
                  )}
                  {!!STATE_LABEL[pr.state] && (
                    <Text style={{ ...font.caption, color: pr.state === "MERGED" ? c.accent : c.foregroundMuted, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 5 }}>
                      {STATE_LABEL[pr.state]}
                    </Text>
                  )}
                  <Dot color={ciColor} size={8} />
                  {!!REVIEW_LABEL[pr.reviewDecision] && <Text style={{ ...font.caption, color: c.foregroundMuted }}>{REVIEW_LABEL[pr.reviewDecision]}</Text>}
                  <Text style={{ ...font.caption, color: c.statusSuccess }}>+{pr.additions}</Text>
                  <Text style={{ ...font.caption, color: c.statusDanger }}>-{pr.deletions}</Text>
                  <Text style={{ ...font.caption, color: c.foregroundMuted }}>{pr.changedFiles} files</Text>
                  {pr.unresolvedThreads > 0 && <Text style={{ ...font.caption, color: c.foregroundMuted }}>{pr.unresolvedThreads} unresolved</Text>}
                  {pr.severity !== null && (
                    <Text style={{ ...font.caption, color: c.foreground, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 5 }}>Sev {pr.severity}</Text>
                  )}
                  {pr.changedSinceMyReview !== null && pr.changedSinceMyReview > 0 && (
                    <Text style={{ ...font.caption, color: c.accent }}>{pr.changedSinceMyReview} changed since your review</Text>
                  )}
                  {pr.labels.slice(0, 3).map((label) => (
                    <View key={label} style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.surface2 }}>
                      <Text numberOfLines={1} style={{ ...font.caption, color: c.foregroundMuted }}>
                        {label}
                      </Text>
                    </View>
                  ))}
                  {extraLabels > 0 && (
                    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.surface2 }}>
                      <Text style={{ ...font.caption, color: c.foregroundMuted }}>+{extraLabels}</Text>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
