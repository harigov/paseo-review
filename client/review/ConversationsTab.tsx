import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { threadReplyRpc } from "../../shared/rpc";
import type { AnalyzedFile, Thread, ThreadTriage } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { ExplainAction } from "./Explain";
import { Chip } from "../ui/chips";
import { Markdown } from "../render/Markdown";
import { font, space, surfaces } from "../ui/tokens";
import { EmptyState, Skeleton } from "../ui/states";

const TRIAGE_LABEL: Record<ThreadTriage, string> = {
  addressed: "Addressed",
  partially: "Partially addressed",
  not_addressed: "Not addressed",
  unclear: "Unclear",
};

interface TriageInfo {
  triage: ThreadTriage;
  probability: number | null;
}

/** Prefers the analysis's thread-triage map (kept fresh independently); falls back to the
 * value embedded on the thread itself (e.g. before a re-analysis has run). */
function resolveTriage(thread: Thread, triageByThreadId: Record<string, { triage: ThreadTriage; probability: number }> | undefined): TriageInfo | null {
  const fromAnalysis = triageByThreadId?.[thread.id];
  if (fromAnalysis) return fromAnalysis;
  if (thread.triage) return { triage: thread.triage, probability: thread.triageProbability };
  return null;
}

function triageText(info: TriageInfo | null): string | null {
  if (!info) return null;
  const label = TRIAGE_LABEL[info.triage];
  return info.probability !== null ? `${label} ${Math.round(info.probability * 100)}%` : label;
}

type Row =
  | { kind: "header"; key: string; title: string }
  | { kind: "thread"; key: string; thread: Thread }
  | { kind: "resolvedHeader"; key: string; count: number }
  | { kind: "resolvedThread"; key: string; thread: Thread };

export function ConversationsTab(props: PrTabContext) {
  const { repo, number, theme, detail, analysis, refresh, openChat } = props;
  const c = theme.colors;
  const s = surfaces(c);
  const toast = useToast();
  const replyRpc = useRpc(threadReplyRpc);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [openReplyIds, setOpenReplyIds] = useState<ReadonlySet<string>>(new Set());
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  const fileByPath = useMemo(() => {
    const map = new Map<string, AnalyzedFile>();
    (analysis?.files ?? []).forEach((file) => map.set(file.path, file));
    return map;
  }, [analysis]);

  const rows = useMemo<Row[]>(() => {
    const threads = detail?.threads ?? [];
    const unresolved = threads.filter((t) => !t.isResolved);
    const resolved = threads.filter((t) => t.isResolved);

    const order: string[] = [];
    const groups = new Map<string, { title: string; threads: Thread[] }>();
    unresolved.forEach((thread) => {
      const moduleId = fileByPath.get(thread.path)?.moduleId ?? "other";
      const moduleTitle = analysis?.modules.find((m) => m.id === moduleId)?.title ?? "Other";
      if (!groups.has(moduleId)) {
        groups.set(moduleId, { title: moduleTitle, threads: [] });
        order.push(moduleId);
      }
      groups.get(moduleId)?.threads.push(thread);
    });

    const out: Row[] = [];
    order.forEach((moduleId) => {
      const group = groups.get(moduleId);
      if (!group) return;
      out.push({ kind: "header", key: `h:${moduleId}`, title: group.title });
      group.threads.forEach((thread) => out.push({ kind: "thread", key: thread.id, thread }));
    });

    if (resolved.length > 0) {
      out.push({ kind: "resolvedHeader", key: "resolved-header", count: resolved.length });
      if (resolvedExpanded) {
        resolved.forEach((thread) => out.push({ kind: "resolvedThread", key: `r:${thread.id}`, thread }));
      }
    }
    return out;
  }, [detail, analysis, fileByPath, resolvedExpanded]);

  function toggleReplyOpen(threadId: string) {
    setOpenReplyIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }

  async function reply(thread: Thread, resolve: boolean) {
    const body = replies[thread.id]?.trim();
    if (!body) return;
    setSending(thread.id);
    try {
      await replyRpc({ repo, number, threadId: thread.id, body, resolve });
      toast.show(resolve ? "Replied and resolved" : "Replied");
      setReplies((prev) => ({ ...prev, [thread.id]: "" }));
      setOpenReplyIds((prev) => {
        const next = new Set(prev);
        next.delete(thread.id);
        return next;
      });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reply");
    } finally {
      setSending(null);
    }
  }

  if (!detail) return <Skeleton theme={theme} rows={4} />;

  const baseUrl = detail.summary.url;

  function renderThreadCard(thread: Thread) {
    const info = resolveTriage(thread, analysis?.threadTriage);
    const text = triageText(info);
    const isOpen = openReplyIds.has(thread.id);
    return (
      <View style={{ ...s.card, gap: space.sm, marginBottom: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Text style={{ ...font.small, fontWeight: "600" as const, color: c.foreground }}>
            {thread.path}
            {thread.line !== null ? `:${thread.line}` : ""}
          </Text>
          {thread.isOutdated ? <Chip label="outdated" color={c.foregroundMuted} /> : null}
          {thread.isResolved ? <Chip label="resolved" color={c.statusSuccess} /> : null}
          {text ? <Chip label={text} color={c.accent} /> : null}
        </View>
        <View style={{ gap: space.sm }}>
          {thread.comments.map((comment, index) => (
            <View key={comment.id} style={{ gap: space.xs }}>
              {index > 0 ? <View style={s.hairline} /> : null}
              <Text style={{ ...font.caption, fontWeight: "600" as const, color: c.foregroundMuted }}>{comment.author}</Text>
              <Markdown body={comment.body} theme={theme} baseUrl={baseUrl} />
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              openChat(`Thread on ${thread.path}${thread.line ? `:${thread.line}` : ""}\n\n${thread.comments.map((cm) => `${cm.author}: ${cm.body}`).join("\n")}`)
            }
          >
            <Text style={{ ...font.small, color: c.accent }}>Ask agent</Text>
          </Pressable>
          <ExplainAction repo={repo} number={number} target={`thread:${thread.id}`} theme={theme} />
          {!isOpen ? (
            <Pressable accessibilityRole="button" onPress={() => toggleReplyOpen(thread.id)}>
              <Text style={{ ...font.small, color: c.accent }}>Reply</Text>
            </Pressable>
          ) : null}
        </View>
        {isOpen ? (
          <View style={{ gap: space.sm }}>
            <TextInput
              value={replies[thread.id] ?? ""}
              onChangeText={(value) => setReplies((prev) => ({ ...prev, [thread.id]: value }))}
              placeholder="Reply…"
              multiline
              style={{ ...s.input, minHeight: 50 }}
            />
            <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
              <Pressable accessibilityRole="button" disabled={sending === thread.id} onPress={() => toggleReplyOpen(thread.id)} style={{ paddingVertical: 7, paddingHorizontal: space.md }}>
                <Text style={{ ...font.small, color: c.foregroundMuted }}>Cancel</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={sending === thread.id} onPress={() => reply(thread, false)} style={s.buttonQuiet}>
                <Text style={s.buttonQuietText}>Reply</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={sending === thread.id} onPress={() => reply(thread, true)} style={s.button}>
                <View style={{ flexDirection: "row", gap: space.xs, alignItems: "center" }}>
                  <Icon name="Check" size={11} color={c.accentForeground} />
                  <Text style={s.buttonText}>Reply &amp; resolve</Text>
                </View>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  function renderRow({ item }: { item: Row }) {
    if (item.kind === "header") {
      return <Text style={{ ...font.title, color: c.foreground, paddingTop: space.md, paddingBottom: space.sm }}>{item.title}</Text>;
    }
    if (item.kind === "resolvedHeader") {
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => setResolvedExpanded((value) => !value)}
          style={{ ...s.card, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.md, marginBottom: space.sm }}
        >
          <Text style={{ ...font.title, color: c.foregroundMuted }}>Resolved ({item.count})</Text>
          <Icon name={resolvedExpanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
        </Pressable>
      );
    }
    return renderThreadCard(item.thread);
  }

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg }}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      ListEmptyComponent={
        <EmptyState
          theme={theme}
          icon="MessageSquare"
          title="No review threads yet"
          hint="Comments you add from the diff show up here once submitted."
        />
      }
    />
  );
}
