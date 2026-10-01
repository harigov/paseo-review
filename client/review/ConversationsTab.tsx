import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { threadReplyRpc } from "../../shared/rpc";
import type { Thread } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { ExplainAction } from "./Explain";

const TRIAGE_LABEL: Record<NonNullable<Thread["triage"]>, string> = {
  addressed: "Addressed",
  partially: "Partially addressed",
  not_addressed: "Not addressed",
  unclear: "Unclear",
};

function triageText(thread: Thread): string | null {
  if (!thread.triage) return null;
  const label = TRIAGE_LABEL[thread.triage];
  return thread.triageProbability !== null ? `${label} ${Math.round(thread.triageProbability * 100)}%` : label;
}

export function ConversationsTab(props: PrTabContext) {
  const { repo, number, theme, detail, analysis, refresh, openChat } = props;
  const c = theme.colors;
  const toast = useToast();
  const replyRpc = useRpc(threadReplyRpc);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  const groups = useMemo(() => {
    const threads = detail?.threads ?? [];
    const sorted = [...threads].sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
    const map = new Map<string, { title: string; threads: Thread[] }>();
    sorted.forEach((thread) => {
      const file = analysis?.files.find((f) => f.path === thread.path);
      const moduleId = file?.moduleId ?? "other";
      const moduleTitle = analysis?.modules.find((m) => m.id === moduleId)?.title ?? "Other";
      if (!map.has(moduleId)) map.set(moduleId, { title: moduleTitle, threads: [] });
      map.get(moduleId)?.threads.push(thread);
    });
    return Array.from(map.values());
  }, [detail, analysis]);

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

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      {groups.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No review threads yet.</Text> : null}
      {groups.map((group) => (
        <View key={group.title} style={{ gap: 8 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{group.title}</Text>
          {group.threads.map((thread) => (
            <View key={thread.id} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10, gap: 6 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Text style={{ color: c.foreground, fontSize: 12 }}>
                  {thread.path}
                  {thread.line !== null ? `:${thread.line}` : ""}
                </Text>
                {thread.isOutdated ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>outdated</Text> : null}
                {thread.isResolved ? <Text style={{ color: c.statusSuccess, fontSize: 10 }}>resolved</Text> : null}
                {triageText(thread) ? (
                  <View style={{ borderWidth: 1, borderColor: c.accent, borderRadius: 4, paddingHorizontal: 5 }}>
                    <Text style={{ color: c.accent, fontSize: 10 }}>{triageText(thread)}</Text>
                  </View>
                ) : null}
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
          ))}
        </View>
      ))}
    </View>
  );
}
