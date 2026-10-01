import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useInbox, useRepos } from "../data/hooks";
import type { InboxSection, PrSummary } from "../../shared/types";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type ReviewDecision = PrSummary["reviewDecision"];

type SortKey = "attention" | "updated" | "created" | "size" | "severity";
type CiFilter = "any" | "failing" | "passing";
type ReviewFilter = "any" | ReviewDecision;

const SECTION_ORDER: InboxSection[] = ["mine", "review_requested", "assigned", "all"];
const SECTION_LABELS: Record<InboxSection, string> = {
  mine: "My PRs",
  review_requested: "Review requested",
  assigned: "Assigned",
  all: "All open",
};

type Row = { kind: "header"; section: InboxSection; count: number } | { kind: "pr"; key: string; pr: PrSummary };

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

const REVIEW_LABEL: Record<ReviewDecision, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
  NONE: "",
};

/**
 * A pressable filter/sort pill (distinct from `client/ui/chips.tsx`'s `Chip`, which is a
 * non-interactive status badge). Module-scope so it isn't redefined — and every instance
 * remounted — on every `Inbox` render.
 */
function FilterChip({ label, active, onPress, c }: { label: string; active: boolean; onPress(): void; c: ThemeColors }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        backgroundColor: active ? c.accent : pressed ? c.surface2 : c.surface1,
      })}
    >
      <Text style={{ fontSize: 12, color: active ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function Inbox({
  theme,
  layout,
  onOpenPr,
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  onOpenPr(ref: { repo: string; number: number }): void;
}) {
  const c = theme.colors;
  const inbox = useInbox();
  const repos = useRepos();
  const [collapsed, setCollapsed] = useState<Partial<Record<InboxSection, boolean>>>({});
  const [search, setSearch] = useState("");
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [hideDrafts, setHideDrafts] = useState(false);
  const [ciFilter, setCiFilter] = useState<CiFilter>("any");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("any");
  const [sort, setSort] = useState<SortKey>("attention");
  const [errorsDismissed, setErrorsDismissed] = useState(false);

  const prs = inbox.data?.prs ?? [];
  const errors = inbox.data?.errors ?? [];
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

  const rows = useMemo(() => {
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
    const out: Row[] = [];
    for (const section of SECTION_ORDER) {
      const inSection = sortPrs(filtered.filter((pr) => pr.sections.includes(section)));
      out.push({ kind: "header", section, count: inSection.length });
      if (!collapsed[section]) {
        for (const pr of inSection) out.push({ kind: "pr", key: `${section}:${pr.repo}#${pr.number}`, pr });
      }
    }
    return out;
  }, [filtered, collapsed, effectiveSort]);

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
      <View style={{ flex: 1, padding: 24, gap: 10, backgroundColor: c.surface0 }}>
        <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>No repos yet</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 20 }}>
          PR Review pulls pull requests from repos already added to Paseo as projects with a github.com
          remote. Add a repo as a Paseo project to see its PRs here.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      {!errorsDismissed && errors.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border }}>
          <Text style={{ flex: 1, color: c.statusDanger, fontSize: 12 }}>{errors.join(" · ")}</Text>
          <Pressable accessibilityRole="button" onPress={() => setErrorsDismissed(true)}>
            <Icon name="X" size={14} color={c.foregroundMuted} />
          </Pressable>
        </View>
      )}
      <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingHorizontal: 10 }}>
            <Icon name="Search" size={14} color={c.foregroundMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search title, author, repo, #number"
              placeholderTextColor={c.foregroundMuted}
              style={{ flex: 1, color: c.foreground, fontSize: 13, paddingVertical: 8 }}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => inbox.refresh()}
            style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
          >
            <Icon name="RefreshCw" size={14} color={c.foreground} />
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
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
        <Text style={{ padding: 16, color: c.foregroundMuted }}>Loading pull requests…</Text>
      ) : inbox.isError ? (
        <Text style={{ padding: 16, color: c.statusDanger }}>Could not load the inbox.</Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row: Row) => (row.kind === "header" ? `h:${row.section}` : row.key)}
          contentContainerStyle={{ padding: 12, gap: 6 }}
          renderItem={({ item }: { item: Row }) => {
            if (item.kind === "header") {
              const isCollapsed = !!collapsed[item.section];
              return (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCollapsed((cur) => ({ ...cur, [item.section]: !cur[item.section] }))}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}
                >
                  <Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} size={14} color={c.foregroundMuted} />
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>
                    {SECTION_LABELS[item.section]} ({item.count})
                  </Text>
                </Pressable>
              );
            }
            const pr = item.pr;
            const ciColor =
              pr.checks === "success" ? c.statusSuccess : pr.checks === "failure" ? c.statusDanger : pr.checks === "pending" ? c.statusWarning : c.foregroundMuted;
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => onOpenPr({ repo: pr.repo, number: pr.number })}
                style={({ pressed }) => ({
                  padding: 12,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: pressed ? c.surface2 : c.surface1,
                  gap: 4,
                })}
              >
                <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
                  {pr.title}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {pr.repo}#{pr.number} · {pr.author} · {relativeAge(pr.updatedAt)}
                  </Text>
                  {pr.isDraft && <Text style={{ color: c.foregroundMuted, backgroundColor: c.surface2, borderRadius: 4, fontSize: 11, paddingHorizontal: 5 }}>Draft</Text>}
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ciColor }} />
                  {!!REVIEW_LABEL[pr.reviewDecision] && <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{REVIEW_LABEL[pr.reviewDecision]}</Text>}
                  <Text style={{ color: c.statusSuccess, fontSize: 11 }}>+{pr.additions}</Text>
                  <Text style={{ color: c.statusDanger, fontSize: 11 }}>-{pr.deletions}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{pr.changedFiles} files</Text>
                  {pr.unresolvedThreads > 0 && <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{pr.unresolvedThreads} unresolved</Text>}
                  {pr.severity !== null && (
                    <Text style={{ color: c.foreground, backgroundColor: c.surface2, borderRadius: 4, fontSize: 11, paddingHorizontal: 5 }}>Sev {pr.severity}</Text>
                  )}
                  {pr.changedSinceMyReview !== null && pr.changedSinceMyReview > 0 && (
                    <Text style={{ color: c.accent, fontSize: 11 }}>{pr.changedSinceMyReview} changed since your review</Text>
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
