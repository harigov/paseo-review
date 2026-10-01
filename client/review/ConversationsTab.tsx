import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { threadReplyRpc } from "../../shared/rpc";
import type { AnalyzedFile, Thread, ThreadTriage } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { ExplainAction } from "./Explain";
import { Chip } from "../ui/chips";

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

type Row = { kind: "header"; key: string; title: string } | { kind: "thread"; key: string; thread: Thread };

export function ConversationsTab(props: PrTabContext) {
  const { repo, number, theme, detail, analysis, refresh, openChat } = props;
  const c = theme.colors;
  const toast = useToast();
  const replyRpc = useRpc(threadReplyRpc);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  const fileByPath = useMemo(() => {
    const map = new Map<string, AnalyzedFile>();
    (analysis?.files ?? []).forEach((file) => map.set(file.path, file));
    return map;
  }, [analysis]);

  const rows = useMemo<Row[]>(() => {
    const threads = detail?.threads ?? [];
    const sorted = [...threads].sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
    const order: string[] = [];
    const groups = new Map<string, { title: string; threads: Thread[] }>();
    sorted.forEach((thread) => {
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
    return out;
  }, [detail, analysis, fileByPath]);

  async function reply(thread: Thread, resolve: boolean) {
    const body = replies[thread.id]?.trim();
    if (!body) return;
    setSending(thread.id);
    try {
      await replyRpc({ repo, number, threadId: thread.id, body, resolve });
      toast.show(resolve ? "Replied and resolved" : "Replied");
      setReplies((prev) => ({ ...prev, [thread.id]: "" }));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reply");
    } finally {
      setSending(null);
    }
  }

  if (!detail) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>Loading conversations…</Text>;

  function renderRow({ item }: { item: Row }) {
    if (item.kind === "header") {
      return (
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600", paddingTop: 12, paddingBottom: 8 }}>{item.title}</Text>
      );
    }
    const thread = item.thread;
    const info = resolveTriage(thread, analysis?.threadTriage);
    const text = triageText(info);
    return (
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10, gap: 6, marginBottom: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Text style={{ color: c.foreground, fontSize: 12 }}>
            {thread.path}
            {thread.line !== null ? `:${thread.line}` : ""}
          </Text>
          {thread.isOutdated ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>outdated</Text> : null}
          {thread.isResolved ? <Text style={{ color: c.statusSuccess, fontSize: 10 }}>resolved</Text> : null}
          {text ? <Chip label={text} color={c.accent} /> : null}
        </View>
        {thread.comments.map((comment) => (
          <View key={comment.id} style={{ gap: 1 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{comment.author}</Text>
            <Text style={{ color: c.foreground, fontSize: 12 }}>{comment.body}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              openChat(`Thread on ${thread.path}${thread.line ? `:${thread.line}` : ""}\n\n${thread.comments.map((cm) => `${cm.author}: ${cm.body}`).join("\n")}`)
            }
          >
            <Text style={{ color: c.accent, fontSize: 11 }}>Ask agent</Text>
          </Pressable>
          <ExplainAction repo={repo} number={number} target={`thread:${thread.id}`} theme={theme} />
        </View>
        <TextInput
          value={replies[thread.id] ?? ""}
          onChangeText={(value) => setReplies((prev) => ({ ...prev, [thread.id]: value }))}
          placeholder="Reply…"
          multiline
          style={{ minHeight: 50, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 6, fontSize: 12 }}
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Pressable
            accessibilityRole="button"
            disabled={sending === thread.id}
            onPress={() => reply(thread, false)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, backgroundColor: c.surface2, borderRadius: 6 }}
          >
            <Text style={{ color: c.foreground, fontSize: 11 }}>Reply</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={sending === thread.id}
            onPress={() => reply(thread, true)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, backgroundColor: c.accent, borderRadius: 6 }}
          >
            <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
              <Icon name="Check" size={11} color={c.accentForeground} />
              <Text style={{ color: c.accentForeground, fontSize: 11 }}>Reply &amp; resolve</Text>
            </View>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16 }}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      ListEmptyComponent={<Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No review threads yet.</Text>}
    />
  );
}
