import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { fileMoveRpc, fileViewedRpc } from "../../shared/rpc";
import type { AnalyzedFile, ViewedState } from "../../shared/types";
import type { ModuleTabProps } from "../pr/tab-props";
import { FileDiffView, type FileDiffFinding } from "../diff/FileDiffView";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

function riskColor(value: number | null, c: ThemeColors): string {
  if (value === null) return c.foregroundMuted;
  if (value >= 4) return c.statusDanger;
  if (value >= 3) return c.statusWarning;
  return c.statusSuccess;
}

function renamedLabel(file: AnalyzedFile): string {
  if (file.oldPath && file.oldPath !== file.path) return `${file.oldPath} → ${file.path}`;
  return file.path;
}

function moduleSourceLabel(file: AnalyzedFile): string {
  if (file.moduleSource === "decision") {
    return `decision ${file.moduleConfidence !== null ? file.moduleConfidence.toFixed(2) : ""}`.trim();
  }
  return file.moduleSource;
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 10 }}>{label}</Text>
    </View>
  );
}

export function ModuleTab(props: ModuleTabProps) {
  const { theme, analysis, detail, repo, number, moduleId, readingOrder, sinceLastReview, refresh, openChat } = props;
  const c = theme.colors;
  const toast = useToast();
  const viewedRpc = useRpc(fileViewedRpc);
  const moveRpc = useRpc(fileMoveRpc);

  const moduleInfo = analysis?.modules.find((m) => m.id === moduleId) ?? null;
  const isNoiseModule = (moduleInfo?.title ?? "").toLowerCase() === "noise" || moduleId === "noise";

  const [viewedOverride, setViewedOverride] = useState<Record<string, ViewedState>>({});
  const [moduleOverride, setModuleOverride] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [sinceViewedPaths, setSinceViewedPaths] = useState<Set<string>>(new Set());

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

  async function toggleViewed(file: AnalyzedFile, viewed: boolean) {
    setViewedOverride((prev) => ({ ...prev, [file.path]: viewed ? "VIEWED" : "UNVIEWED" }));
    try {
      await viewedRpc({ repo, number, path: file.path, viewed });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update viewed state");
    } finally {
      refresh();
    }
  }

  async function moveFile(file: AnalyzedFile, targetModuleId: string) {
    setModuleOverride((prev) => ({ ...prev, [file.path]: targetModuleId }));
    setMovingPath(null);
    try {
      await moveRpc({ repo, number, path: file.path, moduleId: targetModuleId });
      toast.show(`Moved ${file.path}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move file");
    } finally {
      refresh();
    }
  }

  function markViewedAndNext(file: AnalyzedFile) {
    void toggleViewed(file, true);
    setExpanded((prev) => ({ ...prev, [file.path]: false }));
    const currentIndex = visibleFiles.findIndex((candidate) => candidate.path === file.path);
    const next = visibleFiles
      .slice(currentIndex + 1)
      .find((candidate) => (viewedOverride[candidate.path] ?? candidate.viewed) !== "VIEWED");
    if (next) setExpanded((prev) => ({ ...prev, [next.path]: true }));
  }

  const viewedCount = moduleFiles.filter((file) => (viewedOverride[file.path] ?? file.viewed) === "VIEWED").length;
  const effectiveLines = moduleFiles.reduce((sum, file) => sum + file.effectiveLines, 0);
  const otherModules = analysis?.modules.filter((m) => m.id !== moduleId) ?? [];
  const movingFile = movingPath ? moduleFiles.find((file) => file.path === movingPath) ?? null : null;

  if (!analysis) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>Loading module…</Text>;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, gap: 6, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "700", flex: 1 }}>{moduleInfo?.title ?? moduleId}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              openChat(`Module: ${moduleInfo?.title ?? moduleId}\n\nFiles:\n${moduleFiles.map((file) => `- ${file.path}`).join("\n")}`)
            }
            style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Icon name="MessageSquare" size={13} color={c.accent} />
            <Text style={{ color: c.accent, fontSize: 12 }}>Ask about this module</Text>
          </Pressable>
        </View>
        {moduleInfo?.description ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{moduleInfo.description}</Text> : null}
        {moduleInfo?.summary ? <Text style={{ color: c.foreground, fontSize: 12 }}>{moduleInfo.summary}</Text> : null}
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          {viewedCount}/{moduleFiles.length} files viewed · {effectiveLines} effective lines
        </Text>
        {hiddenRebaseOnly.length > 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            {hiddenRebaseOnly.length} file(s) hidden (rebase-only): {hiddenRebaseOnly.map((file) => file.path).join(", ")}
          </Text>
        ) : null}
      </View>

      <View>
        {visibleFiles.map((file) => {
          const viewed = viewedOverride[file.path] ?? file.viewed;
          const isExpanded = expanded[file.path] === true;
          const fileThreads = isExpanded ? detail?.threads.filter((thread) => thread.path === file.path) ?? [] : [];
          const fileFindings: FileDiffFinding[] = isExpanded
            ? analysis.validators.flatMap((result) =>
                result.findings
                  .filter((finding) => finding.path === file.path)
                  .map((finding) => ({ ...finding, validatorId: result.validatorId, validatorTitle: result.title })),
              )
            : [];
          const scope: "full" | "since_viewed" | "since_last_review" =
            viewed === "DISMISSED" && sinceViewedPaths.has(file.path) ? "since_viewed" : sinceLastReview ? "since_last_review" : "full";

          return (
            <View key={file.path} style={{ borderBottomWidth: 1, borderColor: c.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", padding: 10, gap: 8 }}>
                <Pressable accessibilityRole="checkbox" onPress={() => toggleViewed(file, viewed !== "VIEWED")}>
                  <Icon name={viewed === "VIEWED" ? "CheckSquare" : "Square"} size={16} color={viewed === "VIEWED" ? c.statusSuccess : c.foregroundMuted} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setExpanded((prev) => ({ ...prev, [file.path]: !isExpanded }))}
                  style={{ flex: 1, gap: 4 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={{ color: c.foreground, fontSize: 13 }} numberOfLines={1}>
                      {renamedLabel(file)}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{file.status}</Text>
                    <Text style={{ color: c.statusSuccess, fontSize: 11 }}>+{file.additions}</Text>
                    <Text style={{ color: c.statusDanger, fontSize: 11 }}>-{file.deletions}</Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{file.effectiveLines} eff.</Text>
                    {file.movedLines > 0 ? <Chip label={`moved ${file.movedLines}`} color={c.accent} /> : null}
                    {file.risk !== null ? <Chip label={`risk ${file.risk}`} color={riskColor(file.risk, c)} /> : null}
                    {file.complexity !== null ? <Chip label={`cx ${file.complexity}`} color={riskColor(file.complexity, c)} /> : null}
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {file.noiseReason ? <Text style={{ color: c.foregroundMuted, fontSize: 10, fontStyle: "italic" }}>{file.noiseReason}</Text> : null}
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{moduleSourceLabel(file)}</Text>
                    {viewed === "DISMISSED" ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setSinceViewedPaths((prev) => new Set(prev).add(file.path))}
                      >
                        <Text style={{ color: c.statusWarning, fontSize: 10 }}>
                          changed since you viewed
                          {file.changedSinceViewedProbability !== null
                            ? file.changedSinceViewedProbability >= 0.5
                              ? ` · substantive ${Math.round(file.changedSinceViewedProbability * 100)}%`
                              : " · likely trivial"
                            : ""}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setMovingPath(file.path)} style={{ padding: 4 }}>
                  <Icon name="FolderSymlink" size={14} color={c.foregroundMuted} />
                </Pressable>
              </View>
              {isExpanded ? (
                <View style={{ padding: 10, paddingTop: 0, gap: 8 }}>
                  <FileDiffView
                    repo={repo}
                    number={number}
                    path={file.path}
                    scope={scope}
                    theme={theme}
                    layout={props.layout}
                    threads={fileThreads}
                    findings={fileFindings}
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => markViewedAndNext(file)}
                    style={{ alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.accent, borderRadius: 6 }}
                  >
                    <Text style={{ color: c.accentForeground, fontSize: 12 }}>Mark viewed &amp; next</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}
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
