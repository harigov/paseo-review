import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { useAnalysis, useJobRunner, usePr } from "../data/hooks";
import { chatStartRpc, prAnalyzeRpc } from "../../shared/rpc";
import { prReviewSettings } from "../../shared/settings";
import type { ReadingOrder } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { OverviewTab } from "./OverviewTab";
import { VisualTab } from "./VisualTab";
import { ModuleTab } from "../review/ModuleTab";
import { ValidatorsTab } from "../review/ValidatorsTab";
import { ConversationsTab } from "../review/ConversationsTab";
import { ReviewSubmitButton } from "../review/ReviewSubmitButton";

const READING_ORDERS: { id: ReadingOrder; label: string }[] = [
  { id: "foundations", label: "Foundations first" },
  { id: "risk", label: "Riskiest first" },
  { id: "chrono", label: "Chronological" },
];

export function PrScreen(
  props: PluginSurfaceProps & { repo: string; number: number; onBack(): void },
) {
  const { theme, layout, navigation, repo, number, onBack } = props;
  const c = theme.colors;
  const toast = useToast();
  const settings = useSettings(prReviewSettings);
  const detailQuery = usePr(repo, number);
  const analysisQuery = useAnalysis(repo, number);
  const prAnalyze = useRpc(prAnalyzeRpc);
  const chatStart = useRpc(chatStartRpc);
  const analyzeRunner = useJobRunner();
  const triedHeadRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState("overview");
  const [readingOrder, setReadingOrder] = useState<ReadingOrder>("foundations");
  const [sinceLastReview, setSinceLastReview] = useState(false);
  const [initializedReadingOrder, setInitializedReadingOrder] = useState(false);

  useEffect(() => {
    if (!initializedReadingOrder && settings.status === "ready") {
      setReadingOrder(settings.values.readingOrder);
      setInitializedReadingOrder(true);
    }
  }, [initializedReadingOrder, settings.status, settings.status === "ready" ? settings.values.readingOrder : null]);

  const detail = detailQuery.data ?? null;
  const analysis = analysisQuery.data?.analysis ?? null;

  useEffect(() => {
    const headSha = detail?.summary.headSha;
    if (!headSha) return;
    const stale = !analysis || analysis.headSha !== headSha;
    if (stale && triedHeadRef.current !== headSha && !analyzeRunner.running) {
      triedHeadRef.current = headSha;
      void analyzeRunner.run(() => prAnalyze({ repo, number })).then(() => analysisQuery.refetch());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.summary.headSha, analysis?.headSha, analyzeRunner.running]);

  function refresh() {
    void detailQuery.refetch();
    void analysisQuery.refetch();
  }

  function reanalyze() {
    triedHeadRef.current = null;
    void analyzeRunner.run(() => prAnalyze({ repo, number, force: true })).then(() => analysisQuery.refetch());
  }

  async function openChat(seed?: string) {
    toast.show("Starting the PR chat… this can take about 10s.", { variant: "info" });
    try {
      const result = await chatStart({ repo, number, seed });
      navigation?.openAgent({ agentId: result.agentId });
    } catch {
      toast.error("Could not start chat.");
    }
  }

  const ctx: PrTabContext = useMemo(
    () => ({
      theme,
      layout,
      navigation,
      repo,
      number,
      detail,
      analysis,
      readingOrder,
      sinceLastReview,
      refresh,
      openChat,
      openTab: setActiveTab,
    }),
    [theme, layout, navigation, repo, number, detail, analysis, readingOrder, sinceLastReview],
  );

  const moduleTabs = useMemo(() => {
    if (!analysis) return [];
    return analysis.modules.filter((m) => m.fileCount > 0).sort((a, b) => {
      const aNoise = a.id === "noise" ? 1 : 0;
      const bNoise = b.id === "noise" ? 1 : 0;
      return aNoise - bNoise || a.rank - b.rank;
    });
  }, [analysis]);

  const validatorFailCount = analysis?.validators.filter((v) => v.status === "fail").length ?? 0;
  const unresolvedThreads = detail?.threads.filter((t) => !t.isResolved).length ?? 0;

  type TabEntry = { id: string; label: string; badge?: string; riskColor?: string };
  const tabs: TabEntry[] = [
    { id: "overview", label: "Overview" },
    ...moduleTabs.map((m) => ({
      id: `module:${m.id}`,
      label: `${m.title} (${m.viewedFiles}/${m.fileCount})`,
      riskColor: m.maxRisk !== null && m.maxRisk >= 4 ? c.statusDanger : m.maxRisk !== null && m.maxRisk >= 2 ? c.statusWarning : c.statusSuccess,
    })),
    { id: "validators", label: "Validators", badge: validatorFailCount > 0 ? String(validatorFailCount) : undefined },
    { id: "conversations", label: "Conversations", badge: unresolvedThreads > 0 ? String(unresolvedThreads) : undefined },
    { id: "visual", label: "Visual" },
  ];

  if (detailQuery.isPending) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.surface0 }}>
        <Text style={{ color: c.foregroundMuted }}>Loading PR…</Text>
      </View>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: c.surface0 }}>
        <Text style={{ color: c.statusDanger }}>Could not load this PR.</Text>
        <Pressable accessibilityRole="button" onPress={() => detailQuery.refetch()}>
          <Text style={{ color: c.accent }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const summary = detail.summary;

  function renderTabContent() {
    if (activeTab === "overview") return <OverviewTab {...ctx} />;
    if (activeTab === "validators") return <ValidatorsTab {...ctx} />;
    if (activeTab === "conversations") return <ConversationsTab {...ctx} />;
    if (activeTab === "visual") return <VisualTab {...ctx} />;
    if (activeTab.startsWith("module:")) return <ModuleTab {...ctx} moduleId={activeTab.slice("module:".length)} />;
    return <OverviewTab {...ctx} />;
  }

  const TabRail = (
    <View
      style={
        layout.compact
          ? { flexDirection: "row" }
          : { width: 220, borderRightWidth: 1, borderColor: c.border }
      }
    >
      <ScrollView horizontal={layout.compact} contentContainerStyle={{ padding: 8, gap: 4 }}>
        {tabs.map((tab) => (
          <Pressable
            key={tab.id}
            accessibilityRole="button"
            onPress={() => setActiveTab(tab.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 6,
              backgroundColor: activeTab === tab.id ? c.surface2 : pressed ? c.surface1 : "transparent",
            })}
          >
            {tab.riskColor && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tab.riskColor }} />}
            <Text numberOfLines={1} style={{ color: activeTab === tab.id ? c.foreground : c.foregroundMuted, fontSize: 13 }}>
              {tab.label}
            </Text>
            {tab.badge && (
              <Text style={{ fontSize: 10, color: c.accentForeground, backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 5 }}>{tab.badge}</Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={onBack} style={{ padding: 4 }}>
            <Icon name="ChevronLeft" size={18} color={c.foreground} />
          </Pressable>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 16, fontWeight: "600" }}>
            {summary.title}
          </Text>
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {repo}#{number} · {summary.state}
          {summary.isDraft ? " · Draft" : ""} · {summary.baseRef} ← {summary.headRef}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Pressable accessibilityRole="button" onPress={() => void openExternalUrl(summary.url)}>
            <Text style={{ color: c.accent, fontSize: 12 }}>Open on GitHub</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setReadingOrder((cur) => READING_ORDERS[(READING_ORDERS.findIndex((o) => o.id === cur) + 1) % READING_ORDERS.length].id)}
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
          >
            <Text style={{ fontSize: 11, color: c.foreground }}>{READING_ORDERS.find((o) => o.id === readingOrder)?.label}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!analysis?.sinceAnchorSha}
            onPress={() => setSinceLastReview((v) => !v)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: sinceLastReview ? c.accent : c.surface1,
              borderWidth: 1,
              borderColor: c.border,
              opacity: analysis?.sinceAnchorSha ? 1 : 0.5,
            }}
          >
            <Text style={{ fontSize: 11, color: sinceLastReview ? c.accentForeground : c.foreground }}>Since my last review</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void openChat()}
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
          >
            <Text style={{ fontSize: 11, color: c.foreground }}>Chat</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={analyzeRunner.running}
            onPress={reanalyze}
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
          >
            <Text style={{ fontSize: 11, color: c.foreground }}>{analyzeRunner.running ? "Analyzing…" : "Re-analyze"}</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <ReviewSubmitButton {...ctx} />
        </View>
        {analyzeRunner.running && (
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            Analyzing… {analyzeRunner.job?.stage ?? ""} {analyzeRunner.job ? `${Math.round(analyzeRunner.job.progress * 100)}%` : ""}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, flexDirection: layout.compact ? "column" : "row" }}>
        {TabRail}
        <View style={{ flex: 1 }}>{renderTabContent()}</View>
      </View>
    </View>
  );
}
