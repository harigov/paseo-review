import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useInbox, useRepos } from "../data/hooks";
import { isInboxListedPr, type InboxSection, type PrSummary } from "../../shared/types";
import type { InboxFilters } from "../../shared/ui-state";
import { rememberInboxFilters, useInboxFilters, useRecentPrs } from "./ui-state";
import { agoLabel, relativeAge } from "../ui/time";
import { font, radius, space, surfaces, weight } from "../ui/tokens";
import { Dot } from "../ui/chips";
import { ChoiceMenu } from "../ui/ChoiceMenu";
import { EmptyState, ErrorState, InlineLoading, Skeleton } from "../ui/states";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type ReviewDecision = PrSummary["reviewDecision"];

type SortKey = InboxFilters["sort"];
type CiFilter = InboxFilters["ci"];
type ReviewFilter = InboxFilters["review"];
type TabFilter = InboxFilters["tab"];

/** "Needs you" is synthesized client-side (not part of the server's `InboxSection` enum), so the
 * row/header model works over this superset instead of `InboxSection` directly. */
type ClientSection = InboxSection | "needs_you";

/** Tab order: All open (the default) first, so the inbox opens on every PR. */
const TAB_ORDER: ClientSection[] = ["all", "needs_you", "recent", "mine", "review_requested", "assigned"];
const SECTION_LABELS: Record<ClientSection, string> = {
  needs_you: "Needs you",
  recent: "Recently reviewed",
  mine: "My PRs",
  review_requested: "Review requested",
  assigned: "Assigned",
  all: "All open",
};

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
        style={{ width: 28, height: 28, borderRadius: 14 }}
      />
    );
  }
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ ...font.small, color: c.foregroundMuted }}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
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
  const [search, setSearch] = useState(""); // not persisted, per spec
  const [repoFilter, setRepoFilter] = useRememberedFilter("repo", inboxFilters.repo);
  const [hideDrafts, setHideDrafts] = useRememberedFilter("hideDrafts", inboxFilters.hideDrafts);
  const [ciFilter, setCiFilter] = useRememberedFilter("ci", inboxFilters.ci);
  const [reviewFilter, setReviewFilter] = useRememberedFilter("review", inboxFilters.review);
  const [sort, setSort] = useRememberedFilter("sort", inboxFilters.sort);
  const [tab, setTab] = useRememberedFilter("tab", inboxFilters.tab);

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

  // Drop merged PRs and anything not updated in the last 30 days, including snapshots cached
  // before the search queries started excluding them.
  const prs = (inbox.data?.prs ?? []).filter((pr) => isInboxListedPr(pr));
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

  // One tab at a time, so a PR that sits in several GitHub searches appears once.
  const listed = useMemo(() => {
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

    if (tab === "needs_you") {
      const items = filtered.filter(isNeedsYou);
      // "Attention" here is the needs-you order (changed since your review, then review
      // requested). It does not wait on decision-model scores, which other tabs use.
      return sort === "attention" ? sortNeedsYou(items) : sortPrs(items);
    }
    if (tab === "recent") {
      // PRs reviewed from this app, most recent first, then whatever else GitHub says you
      // reviewed. Merely opening a PR doesn't count, and a review only stays listed while the
      // PR itself is still in the inbox (not merged, updated within 30 days).
      const byKey = new Map(filtered.map((pr) => [prKey(pr.repo, pr.number), pr]));
      const seen = new Set<string>();
      const items: PrSummary[] = [];
      for (const recent of recentLocal) {
        const key = prKey(recent.repo, recent.number);
        if (seen.has(key)) continue;
        const pr = byKey.get(key);
        if (!pr) continue;
        if (!recent.reviewedAt && !pr.sections.includes("recent")) continue;
        seen.add(key);
        items.push(pr);
      }
      for (const pr of sortPrs(filtered.filter((item) => item.sections.includes("recent")))) {
        const key = prKey(pr.repo, pr.number);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(pr);
      }
      // Updated (and Attention before scores exist) keeps "reviewed here" first. Any other
      // sort applies to the whole list, so the control matches the order on screen.
      if (sort === "updated" || (sort === "attention" && !haveAttention)) return items;
      return sortPrs(items);
    }
    return sortPrs(filtered.filter((pr) => pr.sections.includes(tab)));
  }, [filtered, effectiveSort, recentLocal, tab, sort, haveAttention]);

  // Per-tab counts under the current search and filters, so the tab row shows where the PRs are.
  const tabCounts = useMemo(() => {
    const reviewedHere = new Set(recentLocal.filter((recent) => recent.reviewedAt).map((recent) => prKey(recent.repo, recent.number)));
    function inTab(pr: PrSummary, candidate: TabFilter): boolean {
      if (candidate === "needs_you") return isNeedsYou(pr);
      if (candidate === "recent") return pr.sections.includes("recent") || reviewedHere.has(prKey(pr.repo, pr.number));
      return pr.sections.includes(candidate);
    }
    return Object.fromEntries(TAB_ORDER.map((candidate) => [candidate, filtered.filter((pr) => inTab(pr, candidate)).length])) as Record<TabFilter, number>;
  }, [filtered, recentLocal]);
  const otherTab = TAB_ORDER.find((candidate) => candidate !== tab && tabCounts[candidate] > 0);

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: "attention", label: "Attention" },
    { value: "updated", label: "Updated" },
    { value: "created", label: "Created" },
    { value: "size", label: "Size" },
    { value: "severity", label: "Severity" },
  ];
  const ciOptions: { value: CiFilter; label: string }[] = [
    { value: "any", label: "Any" },
    { value: "failing", label: "Failing" },
    { value: "passing", label: "Passing" },
  ];
  const reviewOptions: { value: ReviewFilter; label: string }[] = [
    { value: "any", label: "Any" },
    { value: "REVIEW_REQUIRED", label: "Review required" },
    { value: "CHANGES_REQUESTED", label: "Changes requested" },
    { value: "APPROVED", label: "Approved" },
  ];
  const filtersNarrow = Boolean(search.trim() || repoFilter || hideDrafts || ciFilter !== "any" || reviewFilter !== "any");

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
      <View style={{ padding: space.lg, paddingBottom: space.sm, gap: space.md }}>
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
            <Text style={{ ...font.small, color: c.foregroundMuted }}>Updated {agoLabel(inbox.data.fetchedAt)}</Text>
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
          <ChoiceMenu
            c={c}
            title="CI"
            label={ciFilter === "any" ? "CI: any" : ciFilter === "failing" ? "CI: failing" : "CI: passing"}
            value={ciFilter}
            options={ciOptions}
            active={ciFilter !== "any"}
            onChange={(next) => setCiFilter(() => next)}
          />
          <ChoiceMenu
            c={c}
            title="Review"
            label={reviewFilter === "any" ? "Review: any" : REVIEW_LABEL[reviewFilter] || "Review: any"}
            value={reviewFilter}
            options={reviewOptions}
            active={reviewFilter !== "any"}
            onChange={(next) => setReviewFilter(() => next)}
          />
          <ChoiceMenu
            c={c}
            title="Sort"
            label={`Sort: ${sortOptions.find((option) => option.value === sort)?.label ?? "Updated"}`}
            value={sort}
            options={sortOptions}
            active={sort !== "attention"}
            onChange={(next) => setSort(() => next)}
          />
        </View>
      </View>
      <View style={{ borderBottomWidth: 1, borderColor: c.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.xs }}>
          {TAB_ORDER.map((candidate) => {
            const selected = candidate === tab;
            return (
              <Pressable
                key={candidate}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={`${SECTION_LABELS[candidate]}, ${tabCounts[candidate]}`}
                onPress={() => setTab(() => candidate)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.xs + 2,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 2,
                  borderBottomColor: selected ? c.accent : "transparent",
                }}
              >
                <Text style={{ ...font.body, fontWeight: selected ? weight.semibold : weight.regular, color: selected ? c.foreground : c.foregroundMuted }}>
                  {SECTION_LABELS[candidate]}
                </Text>
                <Text style={{ ...font.small, color: c.foregroundMuted }}>{tabCounts[candidate]}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {inbox.isPending ? (
        <Skeleton theme={theme} rows={6} lineHeight={64} widths={["100%", "100%", "100%", "100%", "100%", "100%"]} />
      ) : inbox.isError ? (
        <ErrorState theme={theme} message="Could not load the inbox." onRetry={() => inbox.refresh()} />
      ) : prs.length === 0 ? (
        <EmptyState
          theme={theme}
          title="No pull requests"
          hint="PR Review pulls pull requests from repos already added to Paseo as projects with a github.com remote. Add a repo as a Paseo project to see its PRs here."
        />
      ) : listed.length === 0 && !filtersNarrow ? (
        <EmptyState
          theme={theme}
          title={tab === "needs_you" ? "Nothing needs you" : `Nothing in ${SECTION_LABELS[tab]}`}
          hint={
            tab === "needs_you"
              ? otherTab
                ? `No open pull request is waiting on your review. ${SECTION_LABELS[otherTab]} still has some.`
                : "No open pull request is waiting on your review."
              : otherTab
                ? `${SECTION_LABELS[otherTab]} still has pull requests.`
                : "Nothing in the inbox is in this tab."
          }
          actionLabel={otherTab ? `Show ${SECTION_LABELS[otherTab]}` : undefined}
          onAction={otherTab ? () => setTab(() => otherTab) : undefined}
        />
      ) : listed.length === 0 ? (
        <EmptyState
          theme={theme}
          icon="Filter"
          title="No pull requests match"
          hint="Your search or filters hide every pull request in this list."
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
          data={listed}
          keyExtractor={(pr: PrSummary) => prKey(pr.repo, pr.number)}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          renderItem={({ item: pr }: { item: PrSummary }) => {
            const extraLabels = Math.max(0, pr.labels.length - 3);
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => onOpenPr({ repo: pr.repo, number: pr.number, title: pr.title })}
                style={({ pressed }) => ({ ...s.card, backgroundColor: pressed ? c.surface2 : c.surface1, gap: space.sm })}
              >
                <Text numberOfLines={2} style={{ ...font.title, color: c.foreground }}>
                  {pr.title}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Avatar url={pr.authorAvatarUrl} name={pr.author} c={c} />
                  <Text style={{ ...font.body, color: c.foregroundMuted }}>
                    {pr.repo}#{pr.number} · {pr.author} · {relativeAge(pr.updatedAt)}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  {pr.isDraft && (
                    <Text style={{ ...font.small, color: c.foregroundMuted, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 }}>Draft</Text>
                  )}
                  {!!STATE_LABEL[pr.state] && (
                    <Text style={{ ...font.small, color: pr.state === "MERGED" ? c.accent : c.foregroundMuted, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 }}>
                      {STATE_LABEL[pr.state]}
                    </Text>
                  )}
                  {!!REVIEW_LABEL[pr.reviewDecision] && <Text style={{ ...font.small, color: c.foregroundMuted }}>{REVIEW_LABEL[pr.reviewDecision]}</Text>}
                  {pr.checks === "failure" ? (
                    <Text style={{ ...font.small, color: c.statusDanger }}>CI failing</Text>
                  ) : (
                    <Dot
                      color={pr.checks === "success" ? c.statusSuccess : pr.checks === "pending" ? c.statusWarning : c.foregroundMuted}
                      size={8}
                    />
                  )}
                  <Text style={{ ...font.small, color: c.statusSuccess }}>+{pr.additions.toLocaleString()}</Text>
                  <Text style={{ ...font.small, color: c.statusDanger }}>−{pr.deletions.toLocaleString()}</Text>
                  <Text style={{ ...font.small, color: c.foregroundMuted }}>{pr.changedFiles} files</Text>
                  {pr.unresolvedThreads > 0 && <Text style={{ ...font.small, color: c.foregroundMuted }}>{pr.unresolvedThreads} unresolved</Text>}
                  {pr.severity !== null && (
                    <Text style={{ ...font.small, color: c.foreground, backgroundColor: c.surface2, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 }}>Sev {pr.severity}</Text>
                  )}
                  {pr.changedSinceMyReview !== null && pr.changedSinceMyReview > 0 && (
                    <Text style={{ ...font.small, color: c.accent }}>{pr.changedSinceMyReview} changed since your review</Text>
                  )}
                  {pr.labels.slice(0, 3).map((label) => (
                    <View key={label} style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.surface2 }}>
                      <Text numberOfLines={1} style={{ ...font.small, color: c.foregroundMuted }}>
                        {label}
                      </Text>
                    </View>
                  ))}
                  {extraLabels > 0 && (
                    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.surface2 }}>
                      <Text style={{ ...font.small, color: c.foregroundMuted }}>+{extraLabels}</Text>
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
