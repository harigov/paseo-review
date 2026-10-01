import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { reviewSubmitRpc } from "../../shared/rpc";
import type { PrTabContext } from "../pr/tab-props";
import { clearDrafts, dropStaleDrafts, removeDraft, useDrafts } from "./drafts";

const EVENTS = [
  { event: "APPROVE" as const, label: "Approve" },
  { event: "REQUEST_CHANGES" as const, label: "Request changes" },
  { event: "COMMENT" as const, label: "Comment" },
];

export function ReviewSubmitButton(props: PrTabContext) {
  const { repo, number, theme, refresh, reanalyze, analysis } = props;
  const c = theme.colors;
  const headSha = analysis?.headSha ?? "";
  const drafts = useDrafts(repo, number, headSha);
  const rpc = useRpc(reviewSubmitRpc);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") {
    setSubmitting(true);
    try {
      await rpc({
        repo,
        number,
        event,
        body,
        comments: drafts.map((draft) => ({ path: draft.path, line: draft.line, side: draft.side, body: draft.body })),
      });
      toast.show("Review submitted");
      clearDrafts(repo, number, headSha);
      setBody("");
      setOpen(false);
      refresh();
      // The review just moved the "since my last review" anchor; force a fresh analysis run
      // rather than waiting for the next natural re-analysis.
      reanalyze();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  }

  function openReviewModal() {
    if (headSha) {
      const discarded = dropStaleDrafts(repo, number, headSha);
      if (discarded > 0) {
        toast.show(`Discarded ${discarded} draft comment${discarded === 1 ? "" : "s"} written before the latest push.`, { variant: "warning" });
      }
    }
    setOpen(true);
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={openReviewModal}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.accent, borderRadius: 6 }}
      >
        <Icon name="GitPullRequest" size={13} color={c.accentForeground} />
        <Text style={{ color: c.accentForeground, fontSize: 12 }}>Review ({drafts.length} drafts)</Text>
      </Pressable>
      <Modal title="Submit review" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <View style={{ gap: 10 }}>
            <View style={{ gap: 6 }}>
              {drafts.length === 0 ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No draft comments yet.</Text>
              ) : (
                drafts.map((draft, index) => (
                  <View
                    key={`${draft.path}-${draft.line}-${index}`}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8 }}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                        {draft.path}:{draft.line}
                      </Text>
                      <Text style={{ color: c.foreground, fontSize: 12 }}>{draft.body}</Text>
                    </View>
                    <Pressable accessibilityRole="button" onPress={() => removeDraft(repo, number, headSha, index)}>
                      <Icon name="X" size={14} color={c.foregroundMuted} />
                    </Pressable>
                  </View>
                ))
              )}
            </View>
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Overall review comment (optional)…"
              multiline
              style={{ minHeight: 70, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 }}
            />
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
              {EVENTS.map(({ event, label }) => (
                <Pressable
                  key={event}
                  accessibilityRole="button"
                  disabled={submitting}
                  onPress={() => submit(event)}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    borderRadius: 6,
                    backgroundColor: event === "APPROVE" ? c.statusSuccess : event === "REQUEST_CHANGES" ? c.statusDanger : c.surface2,
                  }}
                >
                  <Text style={{ color: event === "COMMENT" ? c.foreground : c.accentForeground, fontSize: 12 }}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
