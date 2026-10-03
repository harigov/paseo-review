import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { findInboxSummary, useAnalysis, useJobRunner, usePr } from "../data/hooks";
import { prAnalyzeRpc } from "../../shared/rpc";
import { prReviewSettings } from "../../shared/settings";
import type { DiffLayout, ReadingOrder } from "../../shared/types";
import { font, radius, space, surfaces, weight, type DiffDensity } from "../ui/tokens";
import { ErrorState, InlineLoading, Skeleton } from "../ui/states";
import type { ChatContext, PrTabContext } from "../pr/tab-props";
import { useDepthSync } from "../review/depth-sync";
import { Dot, riskColor } from "../ui/chips";
import { useDrafts } from "../review/drafts";
import { OverviewTab } from "./OverviewTab";
import { VisualTab } from "./VisualTab";
import { ModuleTab } from "../review/ModuleTab";
import { ValidatorsTab } from "../review/ValidatorsTab";
import { ConversationsTab } from "../review/ConversationsTab";
import { ReviewSubmitButton } from "../review/ReviewSubmitButton";
import { recordRecentPr, rememberPrTab, useLastLocation } from "./ui-state";
import { StatusPanel } from "../review/StatusPanel";
import { ChatPanel } from "../review/ChatPanel";
import { ErrorBoundary } from "../ui/ErrorBoundary";

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
  const s = surfaces(c);
  const toast = useToast();
  const settings = useSettings(prReviewSettings);
  const detailQuery = usePr(repo, number);
  const analysisQuery = useAnalysis(repo, number);
  const prAnalyze = useRpc(prAnalyzeRpc);
  const analyzeRunner = useJobRunner();
  const triedHeadRef = useRef<string | null>(null);

  // Reopen the tab the user was on when this PR was last shown (persisted across remounts).
  const lastLocation = useLastLocation();
  const [activeTab, setActiveTab] = useState(() =>
    lastLocation.kind === "pr" && lastLocation.repo === repo && lastLocation.number === number && lastLocation.tab ? lastLocation.tab : "overview",
  );
  const selectTab = useCallback(
    (tabId: string) => {
      setActiveTab(tabId);
      rememberPrTab(repo, number, tabId);
    },
    [repo, number],
  );
  const [readingOrder, setReadingOrder] = useState<ReadingOrder>("foundations");
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("inline");
  const [diffDensity, setDiffDensity] = useState<DiffDensity>("comfortable");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [sinceLastReview, setSinceLastReview] = useState(false);
  const [initializedReadingOrder, setInitializedReadingOrder] = useState(false);
  const [statusOpen, setStatusOpen] = useState(true);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [reviewOpenRequest, setReviewOpenRequest] = useState(0);
  // Right column content on wide layouts; the chat panel stays mounted once opened so its
  // agent subscription and message list survive switching back to Status.
  const [panelTab, setPanelTab] = useState<"status" | "chat">("status");
  const [chatMounted, setChatMounted] = useState(false);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [chatContext, setChatContext] = useState<{ context: ChatContext; key: string } | null>(null);

  // Seed per-session view preferences from settings once they load; later toggles stay local.
  useEffect(() => {
    if (!initializedReadingOrder && settings.status === "ready") {
      setReadingOrder(settings.values.readingOrder);
      setDiffLayout(settings.values.diffLayout);
      setDiffDensity(settings.values.diffDensity);
      setInitializedReadingOrder(true);
    }
  }, [initializedReadingOrder, settings.status, settings.status === "ready" ? settings.values.readingOrder : null]);

  const detail = detailQuery.data ?? null;
  const analysis = analysisQuery.data?.analysis ?? null;

  // Keeps modules' rule-based review depth in step with Settings → Review depth.
  useDepthSync({ repo, number, analysis, refetchAnalysis: analysisQuery.refetch });

  // The inbox only knows repo/number when it opens a PR; refresh the recents entry with the title.
  const title = detail?.summary.title;
  useEffect(() => {
    if (title) recordRecentPr({ repo, number, title });
  }, [repo, number, title]);

  useEffect(() => {
    const headSha = detail?.summary.headSha;
    if (!headSha) return;
    const stale = !analysis || analysis.headSha !== headSha;
    if (stale && triedHeadRef.current !== headSha && !analyzeRunner.running) {
      triedHeadRef.current = headSha;
      analyzeRunner
        .run(() => prAnalyze({ repo, number }))
        .then((job) => {
          if (job.status === "error") toast.error(job.error ?? "Could not analyze this PR.");
          return analysisQuery.refetch();
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : "Could not analyze this PR.");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.summary.headSha, analysis?.headSha, analyzeRunner.running]);

  const refresh = useCallback(() => {
    void detailQuery.refetch();
    void analysisQuery.refetch();
  }, [detailQuery, analysisQuery]);

  const reanalyze = useCallback(() => {
    triedHeadRef.current = null;
    analyzeRunner
      .run(() => prAnalyze({ repo, number, force: true }))
      .then((job) => {
        if (job.status === "error") {
          toast.error(job.error ?? "Could not re-analyze this PR.");
          return;
        }
        void detailQuery.refetch();
        void analysisQuery.refetch();
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Could not re-analyze this PR.");
      });
  }, [analyzeRunner, prAnalyze, repo, number, detailQuery, analysisQuery, toast]);

  // Chat happens in the side panel (or a modal on compact layouts), not in the agent view; the
  // panel itself starts or reuses the PR's agent. Context (e.g. "Ask about this module") is
  // attached to the composer and only goes out with the user's own question.
  const openChat = useCallback(
    (input?: { context?: ChatContext }) => {
      if (input?.context) setChatContext({ context: input.context, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
      setChatMounted(true);
      if (layout.compact) {
        setChatModalOpen(true);
      } else {
        setStatusOpen(true);
        setPanelTab("chat");
      }
    },
    [layout.compact],
  );

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
      diffLayout,
      setDiffLayout,
      diffDensity,
      focusPath,
      setFocusPath,
      refresh,
      reanalyze,
      openChat,
      openTab: selectTab,
    }),
    [theme, layout, navigation, repo, number, detail, analysis, readingOrder, sinceLastReview, diffLayout, diffDensity, focusPath, refresh, reanalyze, openChat, selectTab],
  );

  const moduleTabs = useMemo(() => {
    if (!analysis) return [];
    return analysis.modules.filter((m) => m.fileCount > 0).sort((a, b) => {
      const aNoise = a.id === "noise" ? 1 : 0;
      const bNoise = b.id === "noise" ? 1 : 0;
      return aNoise - bNoise || a.rank - b.rank;
    });
  }, [analysis]);

  // Review progress: files outside the "noise" module, counted the same way the server counts
  // a module's `viewedFiles` (viewed === "VIEWED"; DISMISSED files count toward the total but
  // not toward progress, since they were deliberately set aside rather than reviewed).
  const nonNoiseFiles = useMemo(() => (analysis?.files ?? []).filter((file) => file.moduleId !== "noise"), [analysis]);
  const viewedFileCount = useMemo(() => nonNoiseFiles.filter((file) => file.viewed === "VIEWED").length, [nonNoiseFiles]);
  const totalFileCount = nonNoiseFiles.length;
  const nextUnviewed = useMemo(
    () =>
      nonNoiseFiles
        // DISMISSED = viewed once but changed since; it needs another look, so it is a target too.
        .filter((file) => file.viewed !== "VIEWED")
        // Only files the module tab will actually show under the current filter.
        .filter((file) => !sinceLastReview || file.changedSinceLastReview)
        .sort((a, b) => a.order[readingOrder] - b.order[readingOrder])[0] ?? null,
    [nonNoiseFiles, readingOrder, sinceLastReview],
  );
  const goToNextUnviewed = useCallback(() => {
    if (!nextUnviewed) return;
    selectTab(`module:${nextUnviewed.moduleId}`);
    setFocusPath(nextUnviewed.path);
  }, [nextUnviewed, selectTab, setFocusPath]);

  // Same head the submit button uses: diffs (and draft line numbers) come from the live PR head,
  // which can lag behind the analysis for a while after a push.
  const draftsHeadSha = detail?.summary.headSha ?? analysis?.headSha ?? "";
  const drafts = useDrafts(repo, number, draftsHeadSha);

  const validatorFailCount = analysis?.validators.filter((v) => v.status === "fail").length ?? 0;
  const unresolvedThreads = detail?.threads.filter((t) => !t.isResolved).length ?? 0;

  type TabEntry = {
    id: string;
    label: string;
    badge?: string;
    riskColor?: string;
    progress?: { viewed: number; total: number };
    /** Present on module tabs: how much code that module changes. */
    code?: { additions: number; deletions: number };
  };
  const tabs: TabEntry[] = [
    { id: "overview", label: "Overview" },
    ...moduleTabs.map((m) => ({
      id: `module:${m.id}`,
      label: m.title,
      riskColor: riskColor(m.maxRisk, c),
      progress: { viewed: m.viewedFiles, total: m.fileCount },
      code: { additions: m.additions, deletions: m.deletions },
    })),
    { id: "validators", label: "Validators", badge: validatorFailCount > 0 ? String(validatorFailCount) : undefined },
    { id: "conversations", label: "Conversations", badge: unresolvedThreads > 0 ? String(unresolvedThreads) : undefined },
    { id: "visual", label: "Visual" },
  ];

  if (detailQuery.isPending) {
    // An inbox summary for this PR (from the list, or from a surface reopening on its last PR)
    // lets the real header render instantly instead of a generic skeleton — only the body (tabs,
    // diff, etc., which need the full detail) stays skeletal.
    const pendingSummary = findInboxSummary(repo, number);
    if (pendingSummary) {
      return (
        <View style={{ flex: 1, backgroundColor: c.surface0 }}>
          <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: c.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Pressable accessibilityRole="button" onPress={onBack} style={{ padding: 4 }}>
                <Icon name="ChevronLeft" size={18} color={c.foreground} />
              </Pressable>
              <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, ...font.heading }}>
                {pendingSummary.title}
              </Text>
            </View>
            <Text style={{ ...font.small, color: c.foregroundMuted }}>
              {repo}#{number} · {pendingSummary.state}
              {pendingSummary.isDraft ? " · Draft" : ""} · {pendingSummary.baseRef} ← {pendingSummary.headRef}
            </Text>
          </View>
          <Skeleton theme={theme} rows={8} />
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0 }}>
        <View style={{ borderBottomWidth: 1, borderColor: c.border }}>
          <Skeleton theme={theme} rows={3} />
        </View>
        <Skeleton theme={theme} rows={8} />
      </View>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0 }}>
        <ErrorState theme={theme} message="Could not load this PR." onRetry={() => detailQuery.refetch()} />
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
          : { width: 300, borderRightWidth: 1, borderColor: c.border }
      }
    >
      <ScrollView horizontal={layout.compact} contentContainerStyle={{ padding: space.md, gap: space.sm }}>
        {tabs.map((tab, i) => {
          const isModule = tab.progress !== undefined;
          const prevIsModule = i > 0 ? tabs[i - 1].progress !== undefined : false;
          const pct = tab.progress && tab.progress.total > 0 ? Math.round((tab.progress.viewed / tab.progress.total) * 100) : 0;
          return (
            <View key={tab.id}>
              {isModule && !prevIsModule && (
                <>
                  <View style={{ ...s.hairline, marginVertical: space.xs }} />
                  <Text style={{ ...font.small, color: c.foregroundMuted, paddingHorizontal: 12, paddingBottom: 6 }}>Modules</Text>
                </>
              )}
              {!isModule && prevIsModule && <View style={{ ...s.hairline, marginVertical: space.xs }} />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  tab.code && tab.progress
                    ? `${tab.label}, +${tab.code.additions} −${tab.code.deletions}, ${tab.progress.viewed} of ${tab.progress.total} files viewed`
                    : tab.label
                }
                onPress={() => selectTab(tab.id)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: radius.md,
                  backgroundColor: activeTab === tab.id ? c.surface2 : pressed ? c.surface1 : "transparent",
                })}
              >
                {tab.riskColor && <Dot color={tab.riskColor} size={8} />}
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={1} style={{ ...font.body, fontWeight: activeTab === tab.id ? "600" : "400", color: activeTab === tab.id ? c.foreground : c.foregroundMuted }}>
                    {tab.label}
                  </Text>
                  {tab.code && tab.progress && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ ...font.small, color: c.statusSuccess }}>+{tab.code.additions.toLocaleString()}</Text>
                      <Text style={{ ...font.small, color: c.statusDanger }}>−{tab.code.deletions.toLocaleString()}</Text>
                      <Text style={{ ...font.small, color: c.foregroundMuted }}>
                        {tab.progress.viewed} of {tab.progress.total} viewed
                      </Text>
                    </View>
                  )}
                  {tab.progress && (
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" }}>
                      <View style={{ height: 4, width: `${pct}%`, borderRadius: 2, backgroundColor: c.accent }} />
                    </View>
                  )}
                </View>
                {tab.badge && (
                  <View style={{ ...s.pill(true), paddingHorizontal: 6, paddingVertical: 1 }}>
                    <Text style={s.pillText(true)}>{tab.badge}</Text>
                  </View>
                )}
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Pressable accessibilityRole="button" onPress={onBack} style={{ padding: 4 }}>
            <Icon name="ChevronLeft" size={18} color={c.foreground} />
          </Pressable>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, ...font.heading }}>
            {summary.title}
          </Text>
          {!layout.compact && (
            <Pressable accessibilityRole="button" onPress={() => setStatusOpen((v) => !v)} style={{ padding: 4 }}>
              <Icon name={statusOpen ? "PanelRightClose" : "PanelRightOpen"} size={18} color={c.foreground} />
            </Pressable>
          )}
        </View>
        <Text style={{ ...font.body, color: c.foregroundMuted }}>
          {repo}#{number} · {summary.state}
          {summary.isDraft ? " · Draft" : ""} · {summary.baseRef} ← {summary.headRef}
        </Text>

        {analysis && (
          <View style={{ gap: space.xs }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <Text style={{ ...font.body, color: c.foregroundMuted }}>
                {viewedFileCount} of {totalFileCount} files viewed ·
              </Text>
              <Pressable accessibilityRole="button" onPress={() => setReviewOpenRequest((n) => n + 1)}>
                <Text style={{ ...font.body, color: c.accent, textDecorationLine: "underline" }}>
                  {drafts.length} draft{drafts.length === 1 ? "" : "s"}
                </Text>
              </Pressable>
            </View>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" }}>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: c.accent,
                  width: `${totalFileCount > 0 ? Math.round((viewedFileCount / totalFileCount) * 100) : 0}%`,
                }}
              />
            </View>
          </View>
        )}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
          <Pressable accessibilityRole="button" onPress={() => void openExternalUrl(summary.url)}>
            <Text style={{ ...font.body, color: c.accent }}>Open on GitHub</Text>
          </Pressable>
          {layout.compact && (
            <Pressable accessibilityRole="button" onPress={() => setStatusModalOpen(true)} style={s.pill(false)}>
              <Text style={s.pillText(false)}>Status</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={!analysis?.sinceAnchorSha}
            onPress={() => setSinceLastReview((v) => !v)}
            style={{ ...s.pill(sinceLastReview), opacity: analysis?.sinceAnchorSha ? 1 : 0.5 }}
          >
            <Text style={s.pillText(sinceLastReview)}>Since my last review</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setViewOpen(true)} style={s.pill(false)}>
            <Text style={s.pillText(false)}>View</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {analysis && (
            <Pressable
              accessibilityRole="button"
              disabled={!nextUnviewed}
              onPress={goToNextUnviewed}
              style={{ ...s.buttonQuiet, opacity: nextUnviewed ? 1 : 0.5 }}
            >
              <Text style={s.buttonQuietText}>{nextUnviewed ? "Next unviewed" : "All files viewed"}</Text>
            </Pressable>
          )}
          <ReviewSubmitButton {...ctx} openRequest={reviewOpenRequest} />
        </View>
        <Modal title="View" open={viewOpen} onOpenChange={setViewOpen}>
          <Modal.Content>
            <View style={{ gap: space.lg }}>
              <View style={{ gap: space.xs }}>
                <Text style={{ ...font.small, color: c.foregroundMuted }}>Reading order</Text>
                {READING_ORDERS.map((order) => {
                  const selected = readingOrder === order.id;
                  return (
                    <Pressable
                      key={order.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setReadingOrder(order.id)}
                      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 8 }}
                    >
                      <View style={{ width: 16, alignItems: "center" }}>{selected ? <Icon name="Check" size={14} color={c.accent} /> : null}</View>
                      <Text style={{ ...font.body, fontWeight: selected ? weight.semibold : weight.regular, color: c.foreground }}>{order.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {!layout.compact && (
                <View style={{ gap: space.xs }}>
                  <Text style={{ ...font.small, color: c.foregroundMuted }}>Diff</Text>
                  {(["inline", "split"] as const).map((layoutId) => {
                    const selected = diffLayout === layoutId;
                    return (
                      <Pressable
                        key={layoutId}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => setDiffLayout(layoutId)}
                        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 8 }}
                      >
                        <View style={{ width: 16, alignItems: "center" }}>{selected ? <Icon name="Check" size={14} color={c.accent} /> : null}</View>
                        <Text style={{ ...font.body, fontWeight: selected ? weight.semibold : weight.regular, color: c.foreground }}>
                          {layoutId === "inline" ? "Inline diff" : "Split diff"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setViewOpen(false);
                    openChat();
                  }}
                  style={s.buttonQuiet}
                >
                  <Text style={s.buttonQuietText}>Chat</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={analyzeRunner.running}
                  onPress={() => {
                    setViewOpen(false);
                    reanalyze();
                  }}
                  style={{ ...s.buttonQuiet, opacity: analyzeRunner.running ? 0.5 : 1 }}
                >
                  <Text style={s.buttonQuietText}>{analyzeRunner.running ? "Analyzing…" : "Re-analyze"}</Text>
                </Pressable>
              </View>
            </View>
          </Modal.Content>
        </Modal>
        {analyzeRunner.running ? (
          <InlineLoading
            theme={theme}
            label={`Analyzing… ${analyzeRunner.job?.stage ?? ""} ${analyzeRunner.job ? `${Math.round(analyzeRunner.job.progress * 100)}%` : ""}`.trim()}
          />
        ) : (
          analyzeRunner.job?.status === "error" && (
            <Text style={{ ...font.small, color: c.statusDanger }}>
              Analysis failed: {analyzeRunner.job.error ?? "unknown error"}. Try "Re-analyze".
            </Text>
          )
        )}
      </View>
      <View style={{ flex: 1, flexDirection: layout.compact ? "column" : "row" }}>
        {TabRail}
        <View style={{ flex: 1 }}>{renderTabContent()}</View>
        {!layout.compact && statusOpen && (
          <View style={{ width: panelTab === "chat" ? 440 : 380, borderLeftWidth: 1, borderColor: c.border }}>
            <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}>
              {(["status", "chat"] as const).map((tab) => (
                <Pressable
                  key={tab}
                  accessibilityRole="button"
                  onPress={() => {
                    if (tab === "chat") setChatMounted(true);
                    setPanelTab(tab);
                  }}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 12,
                    borderBottomWidth: 2,
                    borderBottomColor: panelTab === tab ? c.accent : "transparent",
                  }}
                >
                  <Text style={{ ...font.body, fontWeight: weight.semibold, color: panelTab === tab ? c.foreground : c.foregroundMuted }}>
                    {tab === "status" ? "Status" : "Chat"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flex: 1, display: panelTab === "status" ? "flex" : "none" }}>
              <StatusPanel {...ctx} />
            </View>
            {chatMounted && (
              <View style={{ flex: 1, display: panelTab === "chat" ? "flex" : "none" }}>
                <ErrorBoundary fallbackTitle="Chat is unavailable on this host." color={c.foregroundMuted}>
                  <ChatPanel
                    repo={repo}
                    number={number}
                    prUrl={summary.url}
                    theme={theme}
                    navigation={navigation}
                    context={chatContext?.context ?? null}
                    contextKey={chatContext?.key}
                  />
                </ErrorBoundary>
              </View>
            )}
          </View>
        )}
      </View>
      {layout.compact && (
        <>
          <Modal title="Status" open={statusModalOpen} onOpenChange={setStatusModalOpen}>
            <Modal.Content>
              <StatusPanel {...ctx} />
            </Modal.Content>
          </Modal>
          <Modal title="Chat" open={chatModalOpen} onOpenChange={setChatModalOpen}>
            <Modal.Content scrollable={false} style={{ flex: 1 }}>
              {chatMounted && (
                <ErrorBoundary fallbackTitle="Chat is unavailable on this host." color={c.foregroundMuted}>
                  <ChatPanel
                    repo={repo}
                    number={number}
                    prUrl={summary.url}
                    theme={theme}
                    navigation={navigation}
                    context={chatContext?.context ?? null}
                    contextKey={chatContext?.key}
                  />
                </ErrorBoundary>
              )}
            </Modal.Content>
          </Modal>
        </>
      )}
    </View>
  );
}
