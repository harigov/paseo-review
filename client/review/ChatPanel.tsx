import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ScrollView as RNScrollView, TextInputKeyPressEventData } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { ChatStartResultSchema, chatStartRpc } from "../../shared/rpc";
import { useJobRunner } from "../data/hooks";
import { Markdown } from "../render/Markdown";
import { Dot } from "../ui/chips";
import { applyTimelineEvent, toChatMessages, type ChatMessage } from "./chat-timeline";

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type ThemeColors = Theme["colors"];

const TIMELINE_PAGE_LIMIT = 200;

function statusColor(status: string | null, c: ThemeColors): string {
  if (status === "running") return c.accent;
  if (status === "error") return c.statusDanger;
  if (status === "idle") return c.statusSuccess;
  return c.foregroundMuted; // initializing, closed, or not yet known
}

function statusLabel(status: string | null): string {
  if (status === "running") return "Running";
  if (status === "idle") return "Idle";
  if (status === "error") return "Error";
  if (status === "closed") return "Closed";
  if (status === "initializing") return "Starting…";
  return "Connecting…";
}

/**
 * `useAgent` (from @getpaseo/plugin/client) throws "Plugin state hooks must run inside a
 * workspace panel" when no `PluginClientStateProvider` is mounted above it — which is exactly
 * the position this panel is in, embedded in the PR screen's own surface rather than a
 * host-rendered workspace/agent panel. The daemon-backed `PaseoAgentHandle` (status/
 * pendingPermissions/activeTurn via `paseo.agents.ref(id)` + its own `.subscribe()`) is this
 * panel's real source of truth; this hook is a best-effort, crash-proof supplement for the
 * fields that exist on `PluginAgentSnapshot` (just `status`/`requiresAttention`/
 * `attentionReason` — no `activeTurn`/`pendingPermissions` there), used when the host happens
 * to provide that context, and quietly treated as absent (null) when it does not.
 */
function useSafeAgentSnapshot(agentId: string | null): { status: string; requiresAttention: boolean; attentionReason: string | null } | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- see comment above: whether this
    // throws is fixed for the lifetime of a given mount (host context shape doesn't change
    // mid-mount), so the hooks called by `useAgent` stay consistent across this instance's renders.
    return useAgent(agentId ?? "", (a) => ({
      status: a.status,
      requiresAttention: a.requiresAttention,
      attentionReason: a.attentionReason,
    }));
  } catch {
    return null;
  }
}

function MessageRow({ message, theme, prUrl }: { message: ChatMessage; theme: Theme; prUrl: string }) {
  const c = theme.colors;
  if (message.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "88%", backgroundColor: c.surface2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{message.text}</Text>
      </View>
    );
  }
  if (message.role === "assistant") {
    return (
      <View style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
        <Markdown body={message.text} theme={theme} baseUrl={prUrl} />
      </View>
    );
  }
  if (message.role === "tool") {
    const color = message.status === "error" ? c.statusDanger : c.foregroundMuted;
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Wrench" size={11} color={color} />
        <Text style={{ color, fontSize: 11, flex: 1 }} numberOfLines={1}>
          {message.text}
          {message.status === "running" ? "…" : ""}
          {message.detail ? ` — ${message.detail}` : ""}
        </Text>
      </View>
    );
  }
  // system (errors, dropped-connection notices)
  return <Text style={{ color: c.statusDanger, fontSize: 12 }}>{message.text}</Text>;
}

export function ChatPanel({
  repo,
  number,
  prUrl,
  theme,
  navigation,
  seed,
  seedKey,
}: {
  repo: string;
  number: number;
  prUrl: string;
  theme: Theme;
  navigation: Navigation;
  seed?: string;
  seedKey?: string;
}) {
  const c = theme.colors;
  const toast = useToast();
  const paseo = usePaseo();
  const chatStart = useRpc(chatStartRpc);
  const startRunner = useJobRunner();

  const [agentId, setAgentId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composerText, setComposerText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [, forceTick] = useReducer((n: number) => n + 1, 0);

  const mountedRef = useRef(true);
  const startedKeyRef = useRef<string | null>(null);
  const sentSeedKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<RNScrollView>(null);
  // `useToast()`'s return identity isn't documented as stable across renders (it's host-
  // injected, not something this plugin controls). Read it through a ref inside the handle
  // effect below so an unstable `toast` object can't force that effect's subscriptions to
  // tear down and re-establish on every render.
  const toastRef = useRef(toast);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  // ---------- start / reuse the PR's chat agent (no seed: the integrator sends it separately
  // once the agent is ready, see the seed effect below) ----------

  const startChatNow = useCallback(() => {
    setStartError(null);
    startRunner
      .run(() => chatStart({ repo, number }))
      .then((job) => {
        if (!mountedRef.current) return;
        if (job.status === "error") {
          setStartError(job.error ?? "Could not start the chat.");
          return;
        }
        const parsed = ChatStartResultSchema.safeParse(job.result);
        if (!parsed.success) {
          setStartError("Chat did not return a valid result.");
          return;
        }
        setAgentId(parsed.data.agentId);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setStartError(error instanceof Error ? error.message : "Could not start the chat.");
      });
    // startRunner/chatStart are fresh per render but stable in behavior; this effect is keyed
    // on repo/number only, same pattern PrScreen.tsx uses for its own job-kickoff effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, number]);

  useEffect(() => {
    const key = `${repo}#${number}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    setAgentId(null);
    setMessages([]);
    sentSeedKeyRef.current = null;
    startChatNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, number]);

  function retryStart() {
    startedKeyRef.current = null;
    startChatNow();
  }

  // ---------- agent handle: one handle instance per agentId, reused for every read/action so
  // its internal `current` snapshot (status/pendingPermissions/activeTurn) stays coherent ----------

  const handle = useMemo(() => (agentId ? paseo.agents.ref(agentId) : null), [paseo, agentId]);

  const refetchTimeline = useCallback(() => {
    if (!handle) return;
    handle.timeline
      .refetch({ limit: TIMELINE_PAGE_LIMIT })
      .then((page) => {
        if (mountedRef.current) setMessages(toChatMessages(page.entries));
      })
      .catch((error) => {
        if (mountedRef.current) toastRef.current.error(error instanceof Error ? error.message : "Could not load the chat timeline.");
      });
  }, [handle]);

  useEffect(() => {
    if (!handle) return;

    // Subscribe before the initial snapshot/refetch (not after): this way any event that
    // lands while that first refetch is still in flight is merged by the handler below
    // rather than silently missed in a dead window with no subscription yet established.
    const unsubscribeTimeline = handle.timeline.subscribe((event) => {
      if (!mountedRef.current) return;
      setMessages((prev) => {
        const next = applyTimelineEvent(prev, event);
        // `applyTimelineEvent` returns [] specifically to signal a replacement epoch: the
        // caller (here) is expected to refetch rather than reconcile across epochs. Keep
        // showing the stale page while the refetch is in flight instead of flashing empty.
        if (next.length === 0 && prev.length > 0) {
          refetchTimeline();
          return prev;
        }
        return next;
      });
    });
    const unsubscribeAgent = handle.subscribe(() => {
      if (mountedRef.current) forceTick();
    });

    // Populates `handle.status`/`.pendingPermissions`/`.activeTurn` for an agent this handle
    // hasn't observed a snapshot of yet (a brand-new `ref()`, before any subscribe/refresh push).
    // `forceTick()` guarantees a render picks up that mutation even if it resolves with no
    // other state update happening to land around the same time.
    void handle
      .refresh()
      .then(() => {
        if (mountedRef.current) forceTick();
      })
      .catch(() => {});
    refetchTimeline();

    return () => {
      unsubscribeTimeline();
      unsubscribeAgent();
    };
  }, [handle, refetchTimeline]);

  // ---------- status: prefer the PluginAgentSnapshot hook when the host provides it, otherwise
  // the handle's own live-updated getters (kept fresh by handle.subscribe + forceTick above) ----------

  const snapshot = useSafeAgentSnapshot(agentId);
  const status = snapshot?.status ?? handle?.status ?? null;
  const attentionReason = snapshot?.attentionReason ?? null;
  const pendingPermissions = handle?.pendingPermissions ?? [];
  const activeTurn = handle?.activeTurn ?? null;
  const running = status === "running" || activeTurn !== null;
  const firstPendingPermission = pendingPermissions[0] ?? null;
  const hasPendingPermission = firstPendingPermission !== null || attentionReason === "permission";

  // ---------- seed: send once per seedKey, only once the agent is ready and idle ----------

  useEffect(() => {
    if (!seed || !seedKey) return;
    if (sentSeedKeyRef.current === seedKey) return;
    if (!agentId || !handle) return;
    if (status !== "idle") return;
    sentSeedKeyRef.current = seedKey;
    handle.send(seed).catch((error) => {
      sentSeedKeyRef.current = null; // allow a retry (e.g. a later seedKey bump, or this one again)
      if (mountedRef.current) toast.error(error instanceof Error ? error.message : "Could not send the seed message.");
    });
  }, [seed, seedKey, agentId, handle, status, toast]);

  // ---------- composer ----------

  async function handleSend() {
    const text = composerText.trim();
    if (!text || !handle || running || sendBusy) return;
    setSendBusy(true);
    setComposerText("");
    try {
      await handle.send(text);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(error instanceof Error ? error.message : "Could not send the message.");
        setComposerText(text);
      }
    } finally {
      if (mountedRef.current) setSendBusy(false);
    }
  }

  async function respondToPermission(behavior: "allow" | "deny") {
    if (!handle || !firstPendingPermission) return;
    try {
      await handle.respondToPermission({ requestId: firstPendingPermission.id, response: { behavior } });
    } catch (error) {
      if (mountedRef.current) toast.error(error instanceof Error ? error.message : "Could not respond to the permission request.");
    }
  }

  function openInPaseo() {
    if (agentId) navigation?.openAgent?.({ agentId });
  }

  const composerDisabled = !composerText.trim() || running || sendBusy || !agentId;

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderBottomWidth: 1, borderColor: c.border }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Chat</Text>
        <Dot color={statusColor(status, c)} />
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{statusLabel(status)}</Text>
        <View style={{ flex: 1 }} />
        {navigation?.openAgent && agentId ? (
          <Pressable accessibilityRole="button" onPress={openInPaseo}>
            <Text style={{ color: c.accent, fontSize: 11 }}>Open in Paseo</Text>
          </Pressable>
        ) : null}
      </View>

      {!agentId ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 16 }}>
          {startError ? (
            <>
              <Text style={{ color: c.statusDanger, fontSize: 12, textAlign: "center" }}>{startError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={retryStart}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: c.surface2 }}
              >
                <Text style={{ color: c.foreground, fontSize: 12 }}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>
              Preparing a PR workspace… this can take about 10 s{startRunner.job?.stage ? ` (${startRunner.job.stage})` : ""}
            </Text>
          )}
        </View>
      ) : (
        <>
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 12, gap: 10 }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Ask anything about this PR — the agent can read the diff and the repo.</Text>
            ) : (
              messages.map((message) => <MessageRow key={message.id} message={message} theme={theme} prUrl={prUrl} />)
            )}
            {running ? <Text style={{ color: c.foregroundMuted, fontSize: 11, fontStyle: "italic" }}>Thinking…</Text> : null}
            {hasPendingPermission ? (
              <View style={{ gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10 }}>
                <Text style={{ color: c.statusWarning, fontSize: 12 }}>Waiting on a permission request</Text>
                {firstPendingPermission?.title || firstPendingPermission?.description ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                    {firstPendingPermission.title ?? firstPendingPermission.description}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable accessibilityRole="button" onPress={openInPaseo} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface2 }}>
                    <Text style={{ color: c.foreground, fontSize: 11 }}>Open in Paseo</Text>
                  </Pressable>
                  {firstPendingPermission ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void respondToPermission("deny")}
                        style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface2 }}
                      >
                        <Text style={{ color: c.statusDanger, fontSize: 11 }}>Deny</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void respondToPermission("allow")}
                        style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.accent }}
                      >
                        <Text style={{ color: c.accentForeground, fontSize: 11 }}>Allow</Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              </View>
            ) : null}
          </ScrollView>

          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", padding: 10, borderTopWidth: 1, borderColor: c.border }}>
            <TextInput
              value={composerText}
              onChangeText={setComposerText}
              placeholder="Ask about this PR…"
              multiline
              editable={!sendBusy}
              onKeyPress={(e) => {
                // Best-effort Enter-to-send on web; Shift+Enter still inserts a newline.
                // `shiftKey` isn't in TextInputKeyPressEventData's typed shape, but web delivers
                // it at runtime, so it's read defensively rather than typed through.
                const native = e.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean };
                if (native.key === "Enter" && !native.shiftKey) {
                  e.preventDefault();
                  if (!composerDisabled) void handleSend();
                }
              }}
              style={{ flex: 1, minHeight: 36, maxHeight: 120, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 }}
            />
            <Pressable
              accessibilityRole="button"
              disabled={composerDisabled}
              onPress={() => void handleSend()}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: composerDisabled ? c.surface2 : c.accent }}
            >
              <Text style={{ color: composerDisabled ? c.foregroundMuted : c.accentForeground, fontSize: 12 }}>Send</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
