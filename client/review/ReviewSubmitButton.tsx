import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { reviewSubmitRpc } from "../../shared/rpc";
import type { PrTabContext } from "../pr/tab-props";
import { clearDrafts, dropStaleDrafts, removeDraft, updateDraft, useDrafts } from "./drafts";
import { markPrReviewed } from "../app/ui-state";
import { font, radius, space, surfaces, weight } from "../ui/tokens";

const EVENTS = [
  { event: "APPROVE" as const, label: "Approve" },
  { event: "REQUEST_CHANGES" as const, label: "Request changes" },
  { event: "COMMENT" as const, label: "Comment" },
];

export function ReviewSubmitButton(props: PrTabContext & { openRequest?: number }) {
  const { repo, number, theme, refresh, reanalyze, analysis, detail } = props;
  const c = theme.colors;
  const s = surfaces(c);
  // Prefer the live PR head: the diffs (and so the drafts' line numbers) come from it, and the
  // analysis can lag behind for a while after a push.
  const headSha = detail?.summary.headSha ?? analysis?.headSha ?? "";
  const drafts = useDrafts(repo, number, headSha);
  const rpc = useRpc(reviewSubmitRpc);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

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
      markPrReviewed(repo, number);
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

  const openRequest = props.openRequest ?? 0;
  const seenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenRequest.current) return;
    seenRequest.current = openRequest;
    if (openRequest > 0) openReviewModal();
  }, [openRequest]);

  function startEditDraft(index: number) {
    setEditingIndex(index);
    setEditBody(drafts[index]?.body ?? "");
  }

  function saveEditDraft(index: number) {
    const body = editBody.trim();
    if (!body) {
      toast.error("A comment can't be empty.");
      return;
    }
    updateDraft(repo, number, headSha, index, body);
    setEditingIndex(null);
    setEditBody("");
  }

  function cancelEditDraft() {
    setEditingIndex(null);
    setEditBody("");
  }

  const canComment = body.trim().length > 0 || drafts.length > 0;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={openReviewModal}
        style={{ ...s.button, flexDirection: "row", alignItems: "center", gap: space.xs }}
      >
        <Icon name="GitPullRequest" size={13} color={c.accentForeground} />
        <Text style={s.buttonText}>Review ({drafts.length} drafts)</Text>
      </Pressable>
      <Modal title="Submit review" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <View style={{ gap: space.md }}>
            <View style={{ gap: space.sm }}>
              {drafts.length === 0 ? (
                <Text style={{ ...font.small, color: c.foregroundMuted }}>No draft comments yet.</Text>
              ) : (
                drafts.map((draft, index) => {
                  const editing = editingIndex === index;
                  return (
                    <View key={draft.id} style={{ ...s.raised, flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                      <View style={{ flex: 1, gap: space.xs }}>
                        <Text style={{ ...font.small, color: c.foregroundMuted }}>
                          {draft.path}:{draft.line}
                        </Text>
                        <View style={s.hairline} />
                        {editing ? (
                          <>
                            <TextInput
                              value={editBody}
                              onChangeText={setEditBody}
                              multiline
                              style={{ ...s.input, minHeight: 60 }}
                            />
                            <View style={{ flexDirection: "row", gap: space.md }}>
                              <Pressable accessibilityRole="button" onPress={cancelEditDraft}>
                                <Text style={{ ...font.small, color: c.foregroundMuted }}>Cancel</Text>
                              </Pressable>
                              <Pressable accessibilityRole="button" onPress={() => saveEditDraft(index)}>
                                <Text style={{ ...font.small, color: c.accent }}>Save</Text>
                              </Pressable>
                            </View>
                          </>
                        ) : (
                          <>
                            <Text style={{ ...font.body, color: c.foreground }}>{draft.body}</Text>
                            <Pressable accessibilityRole="button" onPress={() => startEditDraft(index)}>
                              <Text style={{ ...font.small, color: c.accent }}>Edit</Text>
                            </Pressable>
                          </>
                        )}
                      </View>
                      <Pressable accessibilityRole="button" onPress={() => removeDraft(repo, number, headSha, index)}>
                        <Icon name="X" size={14} color={c.foregroundMuted} />
                      </Pressable>
                    </View>
                  );
                })
              )}
            </View>
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Overall review comment (optional)…"
              multiline
              style={{ ...s.input, minHeight: 70 }}
            />
            <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
              {EVENTS.map(({ event, label }) => {
                const disabled = submitting || (event === "COMMENT" && !canComment);
                return (
                  <Pressable
                    key={event}
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={() => submit(event)}
                    style={{
                      paddingVertical: 7,
                      paddingHorizontal: space.md,
                      borderRadius: radius.md,
                      backgroundColor: event === "APPROVE" ? c.statusSuccess : event === "REQUEST_CHANGES" ? c.statusDanger : c.surface2,
                      opacity: disabled ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ ...font.small, fontWeight: weight.semibold, color: event === "COMMENT" ? c.foreground : c.accentForeground }}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
