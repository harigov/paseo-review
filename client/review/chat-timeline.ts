// Pure mapping from a Paseo agent's timeline to the chat panel's own `ChatMessage` shape.
// No React / react-native / @getpaseo/plugin runtime imports here: this file is exercised by
// tests/chat-timeline.test.ts under tsconfig.server.json (Node globals only). Host packages
// such as @getpaseo/client and @getpaseo/protocol are also off limits — Paseo's client
// compiler resolves `import type`, those specifiers are not plugin SDK modules, and
// `npm ci --omit=dev` does not install them. Every input is handled defensively (`unknown`)
// since both a refetched page and a live stream event are daemon payloads this plugin does
// not control the shape of.

/** Fields this module reads from a live `agent.timeline.subscribe` payload. Structural
 * subset of the host `PaseoAgentTimelineEvent`: `seq`/`timestamp` sit beside `event` on a
 * timeline stream, and the other variants carry no chat content except `error`. */
type AgentTimelineLiveEvent =
  | {
      agentId: string;
      seq?: number;
      timestamp: string;
      event: { type: "timeline"; item: unknown; turnId?: string };
    }
  | { agentId: string; event: { type: "replacement" } }
  | { agentId: string; event: { type: "error"; error: string } }
  | { agentId: string; event: { type: "subscription_restored" } };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  status?: "running" | "done" | "error";
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Runtime shape check standing in for real validation of a daemon-pushed event — just enough
 * structure (`agentId` + a typed `event`) to narrow to `AgentTimelineLiveEvent` and read the
 * `timeline` variant's sibling `seq`/`timestamp` from here on. */
function isAgentTimelineEvent(value: unknown): value is AgentTimelineLiveEvent {
  return isRecord(value) && typeof value.agentId === "string" && isRecord(value.event) && typeof value.event.type === "string";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A refetched timeline page gives each entry `seqStart`/`seqEnd` (never a bare `seq`), but
 * older/other call sites in the wild may still send `seq` — accept either defensively. */
function entrySeq(entry: Record<string, unknown>): number | undefined {
  const seq = entry.seq ?? entry.seqEnd ?? entry.seqStart;
  return typeof seq === "number" ? seq : undefined;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error === undefined || error === null) return "Unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

/** One-line label for a tool_call item, derived from its name/title/structured detail —
 * e.g. "Read file src/x.ts", "Ran git diff…". Falls back to the raw tool name for any
 * detail shape this plugin doesn't specifically recognize (new tool kinds, protocol growth). */
function toolLabel(item: Record<string, unknown>): string {
  const name = asString(item.name) ?? "tool";
  const detail = item.detail;
  if (!isRecord(detail)) return `Ran ${name}`;
  switch (detail.type) {
    case "shell":
      return `Ran ${truncate(asString(detail.command) ?? name, 64)}`;
    case "read":
      return `Read file ${asString(detail.filePath) ?? "a file"}`;
    case "edit":
      return `Edited ${asString(detail.filePath) ?? "a file"}`;
    case "write":
      return `Wrote ${asString(detail.filePath) ?? "a file"}`;
    case "search": {
      const query = asString(detail.query);
      return query ? `Searched for "${truncate(query, 48)}"` : "Searched";
    }
    case "fetch":
      return `Fetched ${asString(detail.url) ?? "a URL"}`;
    case "worktree_setup": {
      const branch = asString(detail.branchName);
      return branch ? `Set up worktree on ${branch}` : "Set up worktree";
    }
    case "sub_agent": {
      const description = asString(detail.description);
      return description ? `Ran sub-agent: ${truncate(description, 48)}` : "Ran sub-agent";
    }
    case "plain_text": {
      const label = asString(detail.label);
      const text = asString(detail.text);
      return label ?? (text ? truncate(text, 64) : `Ran ${name}`);
    }
    case "plan":
      return "Updated the plan";
    default:
      return `Ran ${name}`;
  }
}

function toolStatus(status: unknown): ChatMessage["status"] {
  if (status === "running") return "running";
  if (status === "failed" || status === "canceled") return "error";
  return "done";
}

/** Stable id for a timeline item so a later update (same id) replaces in place instead of
 * appending a duplicate row. Falls back to `fallbackId` (derived by the caller from seq/turn/
 * timestamp) for item kinds that carry no natural identity. */
function itemId(item: Record<string, unknown>, fallbackId: string): string {
  switch (item.type) {
    case "tool_call": {
      const callId = asString(item.callId);
      return callId ? `tool:${callId}` : fallbackId;
    }
    case "user_message": {
      const messageId = asString(item.messageId) ?? asString(item.clientMessageId);
      return messageId ? `user:${messageId}` : fallbackId;
    }
    case "assistant_message": {
      const messageId = asString(item.messageId);
      return messageId ? `assistant:${messageId}` : fallbackId;
    }
    case "plugin": {
      const id = asString(item.id);
      return id ? `plugin:${id}` : fallbackId;
    }
    default:
      return fallbackId;
  }
}

/** Core item -> message mapping, shared by a refetched page's entries and a live `timeline`
 * stream event's single item. Returns null for kinds this panel intentionally omits
 * (thinking/reasoning narration, todo lists, compaction markers, unrecognized plugin items). */
function mapItemToMessage(rawItem: unknown, fallbackId: string): ChatMessage | null {
  if (!isRecord(rawItem) || typeof rawItem.type !== "string") return null;
  const item = rawItem as Record<string, unknown> & { type: string };
  const id = itemId(item, fallbackId);

  switch (item.type) {
    case "user_message":
      return { id, role: "user", text: asString(item.text) ?? "" };
    case "assistant_message":
      return { id, role: "assistant", text: asString(item.text) ?? "" };
    case "tool_call": {
      const status = toolStatus(item.status);
      const errorDetail = status === "error" && "error" in item ? describeError(item.error) : undefined;
      return { id, role: "tool", text: toolLabel(item), status, detail: errorDetail };
    }
    case "error":
      return { id, role: "system", text: asString(item.message) ?? "An error occurred.", status: "error" };
    case "notification":
      // Only surface error-level notifications as chat messages; info/warning are chrome, not
      // conversation content.
      if (item.level === "error") {
        return { id, role: "system", text: asString(item.message) ?? "An error occurred.", status: "error" };
      }
      return null;
    case "thinking":
    case "reasoning":
      return null;
    default:
      // todo, compaction, plugin (non-chat), and any future item kind: omitted defensively.
      return null;
  }
}

/** Maps a refetched timeline page's entries (`{ item, seqStart, seqEnd, ... }`, per
 * FetchAgentTimelinePayload) into chat messages, in order. Entries that resolve to the same
 * id (e.g. a defensive seq-based fallback colliding, or the daemon re-sending an updated row
 * within the same page) keep their first position but show the latest content. */
export function toChatMessages(entries: unknown[]): ChatMessage[] {
  const order: string[] = [];
  const byId = new Map<string, ChatMessage>();
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const seq = entrySeq(entry) ?? index;
    const message = mapItemToMessage(entry.item, `seq:${seq}`);
    if (!message) return;
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
  });
  return order.map((id) => byId.get(id)!);
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === next.id);
  if (index === -1) return [...messages, next];
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

/**
 * Merges one live timeline event (`AgentTimelineLiveEvent`, from `agent.timeline.subscribe`)
 * into the current message list:
 *  - a `timeline` event appends a new item, or updates one already in the list sharing its id
 *    (e.g. an in-flight assistant message whose text keeps growing across events);
 *  - a `replacement` event (new epoch) invalidates everything observed so far — returns `[]`
 *    so the caller refetches the page instead of trying to reconcile two epochs;
 *  - a subscription-level `error` event surfaces as a single (deduped) system message;
 *  - anything else (`subscription_restored`, `turn_started`, `mode_changed`, …) carries no
 *    chat content and leaves the list unchanged.
 */
export function applyTimelineEvent(messages: ChatMessage[], event: unknown): ChatMessage[] {
  if (!isAgentTimelineEvent(event)) return messages;
  const inner = event.event;

  if (inner.type === "replacement") return [];

  if (inner.type === "timeline") {
    // Per AgentStreamMessageSchema, `turnId` lives on the inner event but `seq`/`timestamp`
    // are siblings of `event` on the outer payload, not nested inside it.
    const turnId = inner.turnId ?? "turn";
    const seq = "seq" in event ? event.seq : undefined;
    const timestamp = ("timestamp" in event && event.timestamp) || "";
    const fallbackId = seq !== undefined ? `live:seq:${seq}` : `live:${turnId}:${timestamp}`;
    const message = mapItemToMessage(inner.item, fallbackId);
    return message ? upsertMessage(messages, message) : messages;
  }

  if (inner.type === "error") {
    const text = inner.error || "Lost connection to the agent's timeline.";
    return upsertMessage(messages, { id: "subscription-error", role: "system", text, status: "error" });
  }

  return messages;
}
