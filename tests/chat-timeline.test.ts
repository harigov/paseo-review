import { describe, expect, it } from "vitest";
import { applyTimelineEvent, toChatMessages, type ChatMessage } from "../client/review/chat-timeline";

// Hand-written entries shaped like FetchAgentTimelinePayload["entries"]: `{ item, seqStart,
// seqEnd, turnId, timestamp, ... }`. Only the fields chat-timeline.ts actually reads are filled
// in — the rest of a real entry (provider, sourceSeqRanges, collapsed) is irrelevant here.
function entry(seq: number, item: unknown) {
  return { item, seqStart: seq, seqEnd: seq, turnId: "t1", timestamp: "2026-01-01T00:00:00Z" };
}

describe("toChatMessages", () => {
  it("maps user_message, assistant_message, and tool_call to the expected roles", () => {
    const messages = toChatMessages([
      entry(1, { type: "user_message", text: "What does this PR change?", messageId: "u1" }),
      entry(2, { type: "assistant_message", text: "It refactors the auth module.", messageId: "a1" }),
      entry(3, {
        type: "tool_call",
        callId: "c1",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "src/auth/session.ts" },
      }),
    ]);

    expect(messages).toEqual<ChatMessage[]>([
      { id: "user:u1", role: "user", text: "What does this PR change?" },
      { id: "assistant:a1", role: "assistant", text: "It refactors the auth module." },
      { id: "tool:c1", role: "tool", text: "Read file src/auth/session.ts", status: "done", detail: undefined },
    ]);
  });

  it("derives one-line tool labels from the structured detail, not just the raw name", () => {
    const messages = toChatMessages([
      entry(1, {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "git diff --stat" },
      }),
      entry(2, {
        type: "tool_call",
        callId: "c2",
        name: "Grep",
        status: "failed",
        error: "pattern not found",
        detail: { type: "search", query: "TODO" },
      }),
    ]);

    expect(messages[0]).toEqual({ id: "tool:c1", role: "tool", text: "Ran git diff --stat", status: "running", detail: undefined });
    expect(messages[1]).toEqual({ id: "tool:c2", role: "tool", text: 'Searched for "TODO"', status: "error", detail: "pattern not found" });
  });

  it("omits thinking/reasoning narration", () => {
    const messages = toChatMessages([
      entry(1, { type: "reasoning", text: "Let me look at the diff first." }),
      entry(2, { type: "thinking", text: "Considering edge cases." }),
      entry(3, { type: "assistant_message", text: "Looks good.", messageId: "a1" }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("maps an error item to a system message", () => {
    const messages = toChatMessages([entry(1, { type: "error", message: "The agent crashed." })]);
    expect(messages).toEqual<ChatMessage[]>([{ id: "seq:1", role: "system", text: "The agent crashed.", status: "error" }]);
  });

  it("surfaces error-level notifications but drops info/warning ones", () => {
    const messages = toChatMessages([
      entry(1, { type: "notification", level: "info", message: "Context compacted." }),
      entry(2, { type: "notification", level: "warning", message: "Approaching context limit." }),
      entry(3, { type: "notification", level: "error", message: "Provider rate limited." }),
    ]);
    expect(messages).toEqual<ChatMessage[]>([{ id: "seq:3", role: "system", text: "Provider rate limited.", status: "error" }]);
  });

  it("handles unknown/malformed entries defensively instead of throwing", () => {
    expect(() =>
      toChatMessages([
        null,
        undefined,
        42,
        "not an entry",
        { item: null },
        { item: { type: "todo", items: [] } },
        { item: { type: "some_future_kind", text: "???" } },
        entry(9, { type: "assistant_message", text: "Still works.", messageId: "a9" }),
      ]),
    ).not.toThrow();

    const messages = toChatMessages([
      null,
      { item: { type: "todo", items: [] } },
      entry(9, { type: "assistant_message", text: "Still works.", messageId: "a9" }),
    ]);
    expect(messages).toEqual<ChatMessage[]>([{ id: "assistant:a9", role: "assistant", text: "Still works." }]);
  });

  it("falls back to a seq-based id, keeping first position but latest content, when items carry no natural id", () => {
    const messages = toChatMessages([entry(5, { type: "error", message: "first" }), entry(5, { type: "error", message: "second" })]);
    expect(messages).toEqual<ChatMessage[]>([{ id: "seq:5", role: "system", text: "second", status: "error" }]);
  });
});

describe("applyTimelineEvent", () => {
  function timelineEvent(item: unknown, turnId = "t1", timestamp = "2026-01-01T00:00:01Z") {
    return { agentId: "agent-1", event: { type: "timeline", item, provider: "claude", turnId, timestamp } };
  }

  it("appends a new item from a live timeline event", () => {
    const start: ChatMessage[] = [{ id: "user:u1", role: "user", text: "Hi" }];
    const next = applyTimelineEvent(start, timelineEvent({ type: "assistant_message", text: "Hello!", messageId: "a1" }));
    expect(next).toEqual([
      { id: "user:u1", role: "user", text: "Hi" },
      { id: "assistant:a1", role: "assistant", text: "Hello!" },
    ]);
    // Original array is untouched (the caller holds state via setState, not mutation).
    expect(start).toHaveLength(1);
  });

  it("updates an in-flight assistant message in place as its text grows, instead of duplicating it", () => {
    let messages: ChatMessage[] = [];
    messages = applyTimelineEvent(messages, timelineEvent({ type: "assistant_message", text: "It", messageId: "a1" }));
    messages = applyTimelineEvent(messages, timelineEvent({ type: "assistant_message", text: "It refactors", messageId: "a1" }));
    messages = applyTimelineEvent(messages, timelineEvent({ type: "assistant_message", text: "It refactors auth.", messageId: "a1" }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: "assistant:a1", role: "assistant", text: "It refactors auth." });
  });

  it("updates a tool call's status in place as it finishes", () => {
    let messages: ChatMessage[] = [];
    messages = applyTimelineEvent(
      messages,
      timelineEvent({ type: "tool_call", callId: "c1", name: "Bash", status: "running", error: null, detail: { type: "shell", command: "npm test" } }),
    );
    expect(messages[0]).toMatchObject({ status: "running" });

    messages = applyTimelineEvent(
      messages,
      timelineEvent({ type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "tool:c1", status: "done" });
  });

  it("clears the list on a replacement event so the caller refetches", () => {
    const start: ChatMessage[] = [{ id: "assistant:a1", role: "assistant", text: "stale" }];
    const next = applyTimelineEvent(start, { agentId: "agent-1", event: { type: "replacement", epoch: "epoch-2" } });
    expect(next).toEqual([]);
  });

  it("surfaces a subscription error as a single deduped system message", () => {
    let messages: ChatMessage[] = [{ id: "user:u1", role: "user", text: "Hi" }];
    messages = applyTimelineEvent(messages, { agentId: "agent-1", event: { type: "error", error: "connection lost" } });
    expect(messages).toEqual([
      { id: "user:u1", role: "user", text: "Hi" },
      { id: "subscription-error", role: "system", text: "connection lost", status: "error" },
    ]);
    // A second error replaces the same row rather than piling up.
    messages = applyTimelineEvent(messages, { agentId: "agent-1", event: { type: "error", error: "still lost" } });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ id: "subscription-error", role: "system", text: "still lost", status: "error" });
  });

  it("leaves the list unchanged for events with no chat content (subscription_restored, turn_started, ...)", () => {
    const start: ChatMessage[] = [{ id: "user:u1", role: "user", text: "Hi" }];
    expect(applyTimelineEvent(start, { agentId: "agent-1", event: { type: "subscription_restored" } })).toBe(start);
    expect(applyTimelineEvent(start, { agentId: "agent-1", event: { type: "turn_started", provider: "claude", turnId: "t1" } })).toBe(start);
  });

  it("handles malformed events defensively instead of throwing", () => {
    const start: ChatMessage[] = [{ id: "user:u1", role: "user", text: "Hi" }];
    expect(applyTimelineEvent(start, null)).toBe(start);
    expect(applyTimelineEvent(start, 42)).toBe(start);
    expect(applyTimelineEvent(start, {})).toBe(start);
    expect(applyTimelineEvent(start, { agentId: "agent-1" })).toBe(start);
    expect(applyTimelineEvent(start, { agentId: "agent-1", event: {} })).toBe(start);
  });
});
