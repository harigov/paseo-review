import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PrTabContext } from "../pr/tab-props";
import type { AnalyzedFile, DetailLevel, OutlineEntry } from "../../shared/types";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, resolveModuleLevel, type LevelSource } from "../../shared/levels";
import { useJobRunner } from "../data/hooks";
import { setModuleLevel, useDetailLevels } from "../review/levels";
import { Markdown } from "../render/Markdown";
import { HtmlView } from "../render/HtmlView";
import { GithubHtmlView } from "../render/GithubHtmlView";
import { agentTaskRpc } from "../../shared/rpc";
import { extractRichHtml, stripRichHtml } from "../../shared/rich-html";
import { Chip, Dot, riskColor } from "../ui/chips";
import { font, space, surfaces } from "../ui/tokens";
import { EmptyState, InlineLoading, Skeleton } from "../ui/states";
import { buildChangeMapRows, type ChangeMapRow } from "./change-map";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type Surfaces = ReturnType<typeof surfaces>;

/** The Overview tab's readable column — roughly GitHub's conversation column width. */
const CONTENT_MAX_WIDTH = 880;

/** The PR detail query goes stale (its signed attachment URLs expire) after about 5 minutes;
 * refetch proactively a little before that so images/videos in the description don't 403. */
const PR_DETAIL_REFRESH_AFTER_MS = 4 * 60_000;

const EXPORTED_SURFACE_CHANGES: ReadonlySet<OutlineEntry["change"]> = new Set(["signature", "removed", "renamed"]);
const EXPORTED_SURFACE_CAP = 200;

function exportedSurfaceChangeColor(change: OutlineEntry["change"], c: ThemeColors): string {
  switch (change) {
    case "removed":
      return c.statusDanger;
    case "signature":
      return c.statusWarning;
    default:
      return c.accent;
  }
}

const SEVERITY_LABELS: Record<number, string> = { 1: "Trivial", 2: "Minor", 3: "Moderate", 4: "Major", 5: "Critical" };

function Stat({ label, value, color, c }: { label: string; value: string; color?: string; c: ThemeColors }) {
  return (
    <View style={{ minWidth: 110, gap: 2 }}>
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{label}</Text>
      <Text style={{ ...font.title, color: color ?? c.foreground }}>{value}</Text>
    </View>
  );
}

function changeMapStatusLabel(status: ChangeMapRow["status"]): string {
  switch (status) {
    case "new":
      return "New";
    case "removed":
      return "Removed";
    default:
      return "Changed";
  }
}

function changeMapStatusColor(status: ChangeMapRow["status"], c: ThemeColors): string {
  switch (status) {
    case "new":
      return c.statusSuccess;
    case "removed":
      return c.statusDanger;
    default:
      return c.foregroundMuted;
  }
}

/** The module's "Files | Declarations | Code" review-depth selector, marking whether the
 * current value is the user's own choice, a decision-model recommendation (with its reason as
 * a caption), or just the deterministic default. */
function DepthSegment({
  level,
  source,
  reason,
  onChange,
  c,
  s,
}: {
  level: DetailLevel;
  source: LevelSource;
  reason: string | null;
  onChange(level: DetailLevel): void;
  c: ThemeColors;
  s: Surfaces;
}) {
  return (
    <View style={{ gap: 2 }}>
      {source !== "user" ? (
        <Text style={{ ...font.caption, color: c.foregroundMuted }}>{source === "rule" ? "Recommended" : "Default"}</Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: space.xs }}>
        {DETAIL_LEVELS.map((lvl) => (
          <Pressable
            key={lvl}
            accessibilityRole="button"
            accessibilityState={{ selected: level === lvl }}
            onPress={() => onChange(lvl)}
            style={{ ...s.pill(level === lvl), paddingVertical: 4 }}
          >
            <Text style={s.pillText(level === lvl)}>{DETAIL_LEVEL_LABELS[lvl]}</Text>
          </Pressable>
        ))}
      </View>
      {source === "rule" && reason ? (
        <Text style={{ ...font.caption, color: c.foregroundMuted }} numberOfLines={1}>
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

export function OverviewTab(props: PrTabContext) {
  const { theme, repo, number, detail, analysis, openTab, refresh } = props;
  const c = theme.colors;
  const s = surfaces(c);
  const toast = useToast();
  const agentTask = useRpc(agentTaskRpc);
  const summaryJob = useJobRunner();
  const describeJob = useJobRunner();
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [describeResult, setDescribeResult] = useState<string | null>(null);
  const [describeOpen, setDescribeOpen] = useState(false);
  const levels = useDetailLevels(repo, number);
  const queryClient = useQueryClient();

  // Signed GitHub attachment URLs (private-user-images…?jwt=) in the description HTML expire
  // after ~5 minutes; refetch PR detail on mount if it's already most of the way there, so
  // reopening an old PR doesn't show broken images. Deliberately a one-shot mount check, not a
  // refresh loop — `refresh()` (user-triggered) and the job runners cover everything else.
  useEffect(() => {
    const queryKey = ["prr.pr", repo, number];
    const state = queryClient.getQueryState(queryKey);
    if (state && Date.now() - state.dataUpdatedAt > PR_DETAIL_REFRESH_AFTER_MS) {
      void queryClient.refetchQueries({ queryKey });
    }
  }, [queryClient, repo, number]);

  if (!detail) {
    return <Skeleton theme={theme} rows={6} />;
  }

  const richHtml = analysis?.richDescriptionHtml ?? extractRichHtml(detail.body);
  const markdownBody = stripRichHtml(detail.body);
  const baseUrl = detail.summary.url;

  const totals = analysis?.totals;
  const openThreads = detail.threads.filter((t) => !t.isResolved).length;
  const resolvedThreads = detail.threads.length - openThreads;
  const checksPassing = detail.checks.filter((ck) => ck.state === "success").length;
  const checksFailing = detail.checks.filter((ck) => ck.state === "failure").length;

  const exportedSurfaceGroups: { file: AnalyzedFile; entries: OutlineEntry[] }[] = (analysis?.files ?? [])
    .map((file) => ({
      file,
      entries: (file.outline ?? []).filter((entry) => entry.exported && EXPORTED_SURFACE_CHANGES.has(entry.change)),
    }))
    .filter((group) => group.entries.length > 0);
  const exportedSurfaceTotal = exportedSurfaceGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const exportedSurfaceShown = Math.min(exportedSurfaceTotal, EXPORTED_SURFACE_CAP);
  const exportedSurfaceOmitted = exportedSurfaceTotal - exportedSurfaceShown;
  const exportedSurfaceCapped: { file: AnalyzedFile; entries: OutlineEntry[] }[] = [];
  {
    let remaining = EXPORTED_SURFACE_CAP;
    for (const group of exportedSurfaceGroups) {
      if (remaining <= 0) break;
      const entries = group.entries.slice(0, remaining);
      exportedSurfaceCapped.push({ file: group.file, entries });
      remaining -= entries.length;
    }
  }

  async function runSummary() {
    try {
      await summaryJob.run(() => agentTask({ repo, number, task: "summary" }));
      refresh();
    } catch {
      toast.error("Could not generate a summary.");
    }
  }

  async function runDescribe() {
    try {
      toast.show("Drafting a rich description… this can take a bit.", { variant: "info" });
      const job = await describeJob.run(() => agentTask({ repo, number, task: "describe" }));
      if (job.status === "done") {
        const result = job.result as unknown;
        const markdown = typeof result === "string" ? result : (result as { markdown?: string } | null)?.markdown ?? JSON.stringify(result ?? {}, null, 2);
        setDescribeResult(markdown);
        setDescribeOpen(true);
      } else {
        toast.error(job.error ?? "Describe failed.");
      }
    } catch {
      toast.error("Could not generate a description.");
    }
  }

  const isAuthor = detail.viewer && detail.summary.author === detail.viewer;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: space.lg, alignItems: "center" }}
    >
      <View style={{ maxWidth: CONTENT_MAX_WIDTH, width: "100%", gap: space.lg }}>
        <View style={{ gap: space.sm }}>
          {richHtml && !showMarkdown ? (
            <>
              <HtmlView html={richHtml} theme={theme} />
              <Pressable accessibilityRole="button" onPress={() => setShowMarkdown(true)}>
                <Text style={{ ...font.small, color: c.accent }}>Show markdown instead</Text>
              </Pressable>
            </>
          ) : (
            <>
              {detail.bodyHtml ? (
                <GithubHtmlView html={detail.bodyHtml} markdown={markdownBody} theme={theme} baseUrl={baseUrl} />
              ) : (
                <Markdown body={markdownBody} theme={theme} baseUrl={baseUrl} />
              )}
              {richHtml && (
                <Pressable accessibilityRole="button" onPress={() => setShowMarkdown(false)}>
                  <Text style={{ ...font.small, color: c.accent }}>Show rich description</Text>
                </Pressable>
              )}
            </>
          )}
        </View>

        <View style={{ ...s.card, gap: space.md }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
            <Stat c={c} label="Files" value={String(totals?.files ?? detail.files.length)} />
            <Stat c={c} label="+/-" value={`+${detail.summary.additions} / -${detail.summary.deletions}`} />
            <Stat c={c} label="Effective lines" value={totals ? `${totals.effectiveLines} / ${totals.additions + totals.deletions}` : "—"} />
            <Stat c={c} label="Moved lines" value={String(totals?.movedLines ?? 0)} />
            <Stat c={c} label="Noise files" value={String(totals?.noiseFiles ?? 0)} />
            <Stat c={c} label="Commits" value={String(detail.commits)} />
            <Stat c={c} label="Threads" value={`${openThreads} open / ${resolvedThreads} resolved`} />
            <Stat c={c} label="Checks" value={`${checksPassing} passing / ${checksFailing} failing`} />
            <Stat
              c={c}
              label="Severity"
              value={analysis?.severity ? `${analysis.severity} · ${SEVERITY_LABELS[analysis.severity] ?? ""}` : "—"}
            />
            <Stat c={c} label="Change type" value={analysis?.changeType ?? "—"} />
          </View>
          <Text style={{ ...font.caption, color: analysis?.decisionError ? c.statusDanger : c.foregroundMuted }}>
            {analysis?.decisionError ?? (analysis?.decisionsEnabled === false ? "Decision model off for this repo — enable in settings." : "Decision model active for this repo.")}
          </Text>
        </View>

        {analysis && analysis.modules.length > 0 && (
          <View style={{ gap: space.sm }}>
            <Text style={{ ...font.title, color: c.foreground }}>Change map</Text>
            <View style={s.card}>
              {buildChangeMapRows(analysis.modules, analysis.files).map((row, index) => {
                const resolved = resolveModuleLevel(levels.modules[row.module.id], row.module, analysis.files);
                const modulePaths = analysis.files.filter((f) => f.moduleId === row.module.id).map((f) => f.path);
                return (
                  <View key={row.module.id}>
                    {index > 0 ? <View style={{ ...s.hairline, marginVertical: space.sm }} /> : null}
                    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
                      <Pressable accessibilityRole="button" onPress={() => openTab(`module:${row.module.id}`)}>
                        <Text style={{ ...font.body, fontWeight: "600" as const, color: c.foreground }} numberOfLines={1}>
                          {row.module.title}
                        </Text>
                      </Pressable>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                        <Chip label={changeMapStatusLabel(row.status)} color={changeMapStatusColor(row.status, c)} />
                        {row.countsLabel ? <Text style={{ ...font.small, color: c.foregroundMuted }}>{row.countsLabel}</Text> : null}
                        <Text style={{ ...font.small, color: c.foregroundMuted }}>{row.module.effectiveLines} lines</Text>
                        <Dot color={riskColor(row.module.maxRisk, c)} />
                        <Text style={{ ...font.small, color: c.foregroundMuted }}>
                          {row.module.viewedFiles}/{row.module.fileCount} viewed
                        </Text>
                      </View>
                      <DepthSegment
                        level={resolved.level}
                        source={resolved.source}
                        reason={row.module.levelReason}
                        onChange={(level) => setModuleLevel(repo, number, row.module.id, level, modulePaths)}
                        c={c}
                        s={s}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {exportedSurfaceCapped.length > 0 && (
          <View style={{ gap: space.sm }}>
            <Text style={{ ...font.title, color: c.foreground }}>Exported surface changed</Text>
            <View style={s.card}>
              {exportedSurfaceCapped.map(({ file, entries }, groupIndex) => (
                <View key={file.path} style={{ gap: space.xs }}>
                  {groupIndex > 0 ? <View style={{ ...s.hairline, marginTop: space.xs, marginBottom: space.sm }} /> : null}
                  <Pressable accessibilityRole="button" onPress={() => openTab(`module:${file.moduleId}`)}>
                    <Text style={{ ...font.small, fontWeight: "600" as const, color: c.foreground }} numberOfLines={1}>
                      {file.path}
                    </Text>
                  </Pressable>
                  {entries.map((entry, index) => (
                    <View
                      key={`${entry.name}-${index}`}
                      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", paddingVertical: space.xs }}
                    >
                      <Chip label={entry.change} color={exportedSurfaceChangeColor(entry.change, c)} />
                      <Text style={{ ...font.caption, color: c.foregroundMuted }}>{entry.kind}</Text>
                      <Text style={{ ...font.small, fontWeight: "600" as const, color: c.foreground }}>{entry.name}</Text>
                      {entry.change === "signature" ? (
                        <Text style={{ ...font.caption, color: c.foregroundMuted, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
                          {entry.oldSignature ?? ""} {"→"} {entry.signature}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
            </View>
            {exportedSurfaceOmitted > 0 ? (
              <Text style={{ ...font.caption, color: c.foregroundMuted }}>… and {exportedSurfaceOmitted} more</Text>
            ) : null}
          </View>
        )}

        {analysis && analysis.validators.length > 0 && (
          <Pressable
            accessibilityRole="button"
            onPress={() => openTab("validators")}
            style={{ ...s.card, flexDirection: "row", gap: space.lg }}
          >
            <Text style={{ ...font.small, color: c.statusDanger }}>Fail {analysis.validators.filter((v) => v.status === "fail").length}</Text>
            <Text style={{ ...font.small, color: c.statusWarning }}>Uncertain {analysis.validators.filter((v) => v.status === "uncertain").length}</Text>
            <Text style={{ ...font.small, color: c.statusSuccess }}>Pass {analysis.validators.filter((v) => v.status === "pass").length}</Text>
            <Text style={{ ...font.small, color: c.foregroundMuted }}>N/A {analysis.validators.filter((v) => v.status === "na").length}</Text>
          </Pressable>
        )}

        <View style={{ gap: space.sm }}>
          <Text style={{ ...font.title, color: c.foreground }}>Summary</Text>
          {analysis?.summary ? (
            <Markdown body={analysis.summary} theme={theme} baseUrl={baseUrl} />
          ) : summaryJob.running ? (
            <InlineLoading theme={theme} label={`Generating… ${summaryJob.job?.stage ?? ""}`} />
          ) : (
            <EmptyState
              theme={theme}
              icon="FileText"
              title="No summary yet"
              hint="Generate an AI summary of what changed and why."
              actionLabel="Generate summary"
              onAction={runSummary}
            />
          )}
        </View>

        {isAuthor && (
          <Pressable
            accessibilityRole="button"
            disabled={describeJob.running}
            onPress={runDescribe}
            style={{ alignSelf: "flex-start", ...s.buttonQuiet }}
          >
            <Text style={s.buttonQuietText}>
              {describeJob.running ? `Drafting… ${describeJob.job?.stage ?? ""}` : "Describe PR (rich HTML)"}
            </Text>
          </Pressable>
        )}

        <Modal title="Rich description draft" open={describeOpen} onOpenChange={setDescribeOpen}>
          <Modal.Content>
            <Text selectable style={{ ...font.body, fontFamily: "monospace", color: c.foreground }}>
              {describeResult}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (describeResult) void copyText(describeResult).then(() => toast.show("Copied.", { variant: "success" }));
              }}
              style={{ alignSelf: "flex-start", marginTop: space.md, ...s.buttonQuiet }}
            >
              <Text style={s.buttonQuietText}>Copy markdown</Text>
            </Pressable>
          </Modal.Content>
        </Modal>
      </View>
    </ScrollView>
  );
}
