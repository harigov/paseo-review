import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PrTabContext } from "../pr/tab-props";
import type { PrCheck, ReviewDecision, ReviewState, ValidatorResult } from "../../shared/types";
import { Chip, Dot } from "../ui/chips";
import { validatorScoreboard } from "./ValidatorResultsList";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type ChecksState = PrCheck["state"];

/** Local to this panel — deliberately not imported from Inbox.tsx, which has its own copy. */
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

const REVIEW_DECISION_CHIP: Partial<Record<ReviewDecision, { label: string; color: (c: ThemeColors) => string }>> = {
  APPROVED: { label: "Approved", color: (c) => c.statusSuccess },
  CHANGES_REQUESTED: { label: "Changes requested", color: (c) => c.statusDanger },
  REVIEW_REQUIRED: { label: "Review required", color: (c) => c.statusWarning },
};

const REVIEW_STATE_ICON: Record<ReviewState, { name: string; color: (c: ThemeColors) => string }> = {
  APPROVED: { name: "Check", color: (c) => c.statusSuccess },
  CHANGES_REQUESTED: { name: "X", color: (c) => c.statusDanger },
  COMMENTED: { name: "MessageCircle", color: (c) => c.foregroundMuted },
  DISMISSED: { name: "Minus", color: (c) => c.foregroundMuted },
  PENDING: { name: "Minus", color: (c) => c.foregroundMuted },
};

const CHECK_STATE_RANK: Record<ChecksState, number> = { failure: 0, pending: 1, success: 2, none: 3 };

const CHECK_DOT_COLOR: Record<ChecksState, (c: ThemeColors) => string> = {
  success: (c) => c.statusSuccess,
  failure: (c) => c.statusDanger,
  pending: (c) => c.statusWarning,
  none: (c) => c.foregroundMuted,
};

const VALIDATOR_SEVERITY_RANK: Record<ValidatorResult["severity"], number> = { blocking: 0, warning: 1, info: 2 };

/** Groups checks by `app` (or "Statuses" when absent), preserving the incoming order — callers
 * sort by state first so the group containing the worst state surfaces first. */
function groupChecksByApp(checks: PrCheck[]): { app: string; checks: PrCheck[] }[] {
  const groups: { app: string; checks: PrCheck[] }[] = [];
  const indexByApp = new Map<string, number>();
  for (const check of checks) {
    const key = check.app ?? "Statuses";
    let index = indexByApp.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByApp.set(key, index);
      groups.push({ app: key, checks: [] });
    }
    groups[index].checks.push(check);
  }
  return groups;
}

/** Right-hand status panel: review state (humans and bots), CI checks grouped by app, and the
 * validator scoreboard. Rendered as a fixed right column on wide layouts and inside a modal on
 * compact ones (see PrScreen.tsx). */
export function StatusPanel(props: PrTabContext) {
  const { theme, detail, analysis, openTab } = props;
  const c = theme.colors;

  const sectionTitle = { fontSize: 12, fontWeight: "600" as const, color: c.foreground };
  const rowText = { fontSize: 12, color: c.foreground };
  const muted = { fontSize: 11, color: c.foregroundMuted };

  if (!detail) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12 }}>
        <Text style={muted}>Loading…</Text>
      </ScrollView>
    );
  }

  const reviewDecisionChip = REVIEW_DECISION_CHIP[detail.summary.reviewDecision];
  const unresolvedThreads = detail.threads.filter((t) => !t.isResolved).length;

  const sortedChecks = [...detail.checks].sort((a, b) => CHECK_STATE_RANK[a.state] - CHECK_STATE_RANK[b.state]);
  const checkGroups = groupChecksByApp(sortedChecks);
  const checksPassing = detail.checks.filter((ck) => ck.state === "success").length;
  const checksFailing = detail.checks.filter((ck) => ck.state === "failure").length;
  const checksPending = detail.checks.filter((ck) => ck.state === "pending").length;

  const failingValidators = (analysis?.validators ?? [])
    .filter((v) => v.status === "fail")
    .sort((a, b) => VALIDATOR_SEVERITY_RANK[a.severity] - VALIDATOR_SEVERITY_RANK[b.severity]);
  const uncertainValidators = (analysis?.validators ?? []).filter((v) => v.status === "uncertain");

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 20 }}>
      <View style={{ gap: 6 }}>
        <Text style={sectionTitle}>Review</Text>
        {reviewDecisionChip && <Chip label={reviewDecisionChip.label} color={reviewDecisionChip.color(c)} />}
        {detail.reviews.length === 0 ? (
          <Text style={muted}>No reviews yet.</Text>
        ) : (
          detail.reviews.map((review, index) => {
            const icon = REVIEW_STATE_ICON[review.state];
            const row = (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon name={icon.name} size={13} color={icon.color(c)} />
                <Text numberOfLines={1} style={{ ...rowText, flex: 1 }}>
                  {review.author}
                </Text>
                {review.authorKind === "bot" && <Chip label="bot" color={c.foregroundMuted} />}
                {review.submittedAt && <Text style={muted}>{relativeAge(review.submittedAt)}</Text>}
              </View>
            );
            const key = `${review.author}-${review.state}-${index}`;
            return review.url ? (
              <Pressable key={key} accessibilityRole="button" onPress={() => void openExternalUrl(review.url!)}>
                {row}
              </Pressable>
            ) : (
              <View key={key}>{row}</View>
            );
          })
        )}
        {detail.reviewRequests.length > 0 && (
          <Text style={muted}>
            Requested: {detail.reviewRequests.map((r) => (r.kind === "team" ? `team/${r.name}` : r.name)).join(", ")}
          </Text>
        )}
        {unresolvedThreads > 0 && (
          <Pressable accessibilityRole="button" onPress={() => openTab("conversations")}>
            <Text style={muted}>{unresolvedThreads} unresolved threads</Text>
          </Pressable>
        )}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={sectionTitle}>Checks</Text>
        {detail.checks.length === 0 ? (
          <Text style={muted}>No checks.</Text>
        ) : (
          <>
            <Text style={muted}>
              {checksPassing} passing · {checksFailing} failing · {checksPending} pending
            </Text>
            {checkGroups.map((group) => (
              <View key={group.app} style={{ gap: 4 }}>
                <Text style={{ ...muted, fontWeight: "600" as const }}>{group.app}</Text>
                {group.checks.map((check, index) => {
                  const row = (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Dot color={CHECK_DOT_COLOR[check.state](c)} />
                      <Text numberOfLines={1} style={{ ...rowText, flex: 1 }}>
                        {check.name}
                      </Text>
                    </View>
                  );
                  const key = `${group.app}-${check.name}-${index}`;
                  return check.url ? (
                    <Pressable key={key} accessibilityRole="button" onPress={() => void openExternalUrl(check.url!)}>
                      {row}
                    </Pressable>
                  ) : (
                    <View key={key}>{row}</View>
                  );
                })}
              </View>
            ))}
          </>
        )}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={sectionTitle}>Validators</Text>
        {!analysis ? (
          <Text style={muted}>Not analyzed yet.</Text>
        ) : (
          <>
            <Text style={muted}>{validatorScoreboard(analysis.validators)}</Text>
            {analysis.decisionsEnabled === false && <Text style={muted}>Decision model off for this repo.</Text>}
            {[...failingValidators, ...uncertainValidators].map((result) => (
              <Pressable
                key={result.validatorId}
                accessibilityRole="button"
                onPress={() => openTab("validators")}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Text style={{ fontSize: 12, color: result.status === "fail" ? c.statusDanger : c.statusWarning }}>
                  {result.status === "fail" ? "✗" : "?"}
                </Text>
                <Text numberOfLines={1} style={{ ...rowText, flex: 1 }}>
                  {result.title}
                </Text>
                <Text style={muted}>{result.severity}</Text>
                <Text style={muted}>{result.findings.length} findings</Text>
              </Pressable>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}
