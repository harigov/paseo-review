import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PrTabContext } from "../pr/tab-props";
import type { AnalyzedFile, OutlineEntry } from "../../shared/types";
import { useJobRunner } from "../data/hooks";
import { Markdown } from "../render/Markdown";
import { HtmlView } from "../render/HtmlView";
import { GithubHtmlView } from "../render/GithubHtmlView";
import { agentTaskRpc } from "../../shared/rpc";
import { extractRichHtml, stripRichHtml } from "../../shared/rich-html";
import { Chip } from "../ui/chips";

const EXPORTED_SURFACE_CHANGES: ReadonlySet<OutlineEntry["change"]> = new Set(["signature", "removed", "renamed"]);
const EXPORTED_SURFACE_CAP = 200;

function exportedSurfaceChangeColor(change: OutlineEntry["change"], c: PrTabContext["theme"]["colors"]): string {
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

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ minWidth: 110, gap: 2 }}>
      <Text style={{ fontSize: 11, color: "#888" }}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color }}>{value}</Text>
    </View>
  );
}

export function OverviewTab(props: PrTabContext) {
  const { theme, repo, number, detail, analysis, openTab, refresh } = props;
  const c = theme.colors;
  const toast = useToast();
  const agentTask = useRpc(agentTaskRpc);
  const summaryJob = useJobRunner();
  const describeJob = useJobRunner();
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [describeResult, setDescribeResult] = useState<string | null>(null);
  const [describeOpen, setDescribeOpen] = useState(false);

  if (!detail) {
    return <Text style={{ padding: 16, color: c.foregroundMuted }}>Loading…</Text>;
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
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        {richHtml && !showMarkdown ? (
          <>
            <HtmlView html={richHtml} theme={theme} />
            <Pressable accessibilityRole="button" onPress={() => setShowMarkdown(true)}>
              <Text style={{ color: c.accent, fontSize: 12 }}>Show markdown instead</Text>
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
                <Text style={{ color: c.accent, fontSize: 12 }}>Show rich description</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, padding: 12, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
        <Stat label="Files" value={String(totals?.files ?? detail.files.length)} />
        <Stat label="+/-" value={`+${detail.summary.additions} / -${detail.summary.deletions}`} />
        <Stat label="Effective lines" value={totals ? `${totals.effectiveLines} / ${totals.additions + totals.deletions}` : "—"} />
        <Stat label="Moved lines" value={String(totals?.movedLines ?? 0)} />
        <Stat label="Noise files" value={String(totals?.noiseFiles ?? 0)} />
        <Stat label="Commits" value={String(detail.commits)} />
        <Stat label="Threads" value={`${openThreads} open / ${resolvedThreads} resolved`} />
        <Stat label="Checks" value={`${checksPassing} passing / ${checksFailing} failing`} />
        <Stat
          label="Severity"
          value={analysis?.severity ? `${analysis.severity} · ${SEVERITY_LABELS[analysis.severity] ?? ""}` : "—"}
        />
        <Stat label="Change type" value={analysis?.changeType ?? "—"} />
      </View>

      <View style={{ padding: 10, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
        <Text style={{ fontSize: 12, color: analysis?.decisionError ? c.statusDanger : c.foregroundMuted }}>
          {analysis?.decisionError ?? (analysis?.decisionsEnabled === false ? "Decision model off for this repo — enable in settings." : "Decision model active for this repo.")}
        </Text>
      </View>

      {analysis && analysis.modules.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Modules</Text>
          {analysis.modules.filter((m) => m.fileCount > 0).map((m) => (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              onPress={() => openTab(`module:${m.id}`)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                padding: 10,
                borderRadius: 6,
                backgroundColor: pressed ? c.surface2 : c.surface1,
                borderWidth: 1,
                borderColor: c.border,
              })}
            >
              <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }}>{m.title}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{m.fileCount} files</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{m.effectiveLines} lines</Text>
              {m.maxRisk !== null && <Text style={{ color: c.statusWarning, fontSize: 12 }}>risk {m.maxRisk}</Text>}
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {m.viewedFiles}/{m.fileCount} viewed
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {exportedSurfaceCapped.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Exported surface changed</Text>
          {exportedSurfaceCapped.map(({ file, entries }) => (
            <View key={file.path} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: "hidden" }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => openTab(`module:${file.moduleId}`)}
                style={({ pressed }) => ({ padding: 8, backgroundColor: pressed ? c.surface2 : c.surface1 })}
              >
                <Text style={{ color: c.foreground, fontSize: 12 }} numberOfLines={1}>
                  {file.path}
                </Text>
              </Pressable>
              {entries.map((entry, index) => (
                <View
                  key={`${entry.name}-${index}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: 1, borderColor: c.border }}
                >
                  <Chip label={entry.change} color={exportedSurfaceChangeColor(entry.change, c)} />
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{entry.kind}</Text>
                  <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{entry.name}</Text>
                  {entry.change === "signature" ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
                      {entry.oldSignature ?? ""} {"→"} {entry.signature}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
          {exportedSurfaceOmitted > 0 ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>… and {exportedSurfaceOmitted} more</Text>
          ) : null}
        </View>
      )}

      {analysis && analysis.validators.length > 0 && (
        <Pressable
          accessibilityRole="button"
          onPress={() => openTab("validators")}
          style={{ flexDirection: "row", gap: 14, padding: 10, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ color: c.statusDanger, fontSize: 12 }}>Fail {analysis.validators.filter((v) => v.status === "fail").length}</Text>
          <Text style={{ color: c.statusWarning, fontSize: 12 }}>Uncertain {analysis.validators.filter((v) => v.status === "uncertain").length}</Text>
          <Text style={{ color: c.statusSuccess, fontSize: 12 }}>Pass {analysis.validators.filter((v) => v.status === "pass").length}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>N/A {analysis.validators.filter((v) => v.status === "na").length}</Text>
        </Pressable>
      )}

      <View style={{ gap: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Summary</Text>
        {analysis?.summary ? (
          <Markdown body={analysis.summary} theme={theme} baseUrl={baseUrl} />
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={summaryJob.running}
            onPress={runSummary}
            style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
          >
            <Text style={{ color: c.foreground, fontSize: 13 }}>
              {summaryJob.running ? `Generating… ${summaryJob.job?.stage ?? ""}` : "Generate summary"}
            </Text>
          </Pressable>
        )}
      </View>

      {isAuthor && (
        <Pressable
          accessibilityRole="button"
          disabled={describeJob.running}
          onPress={runDescribe}
          style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ color: c.foreground, fontSize: 13 }}>
            {describeJob.running ? `Drafting… ${describeJob.job?.stage ?? ""}` : "Describe PR (rich HTML)"}
          </Text>
        </Pressable>
      )}

      <Modal title="Rich description draft" open={describeOpen} onOpenChange={setDescribeOpen}>
        <Modal.Content>
          <Text selectable style={{ color: c.foreground, fontSize: 13, fontFamily: "monospace" }}>
            {describeResult}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (describeResult) void copyText(describeResult).then(() => toast.show("Copied.", { variant: "success" }));
            }}
            style={{ alignSelf: "flex-start", marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: c.surface2 }}
          >
            <Text style={{ color: c.foreground, fontSize: 13 }}>Copy markdown</Text>
          </Pressable>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
