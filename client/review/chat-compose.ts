// Pure composer for the message actually sent to the chat agent on Send: the user's question
// followed by the attached context chip, if any. No React / react-native imports here — this
// file is exercised by tests/chat-compose.test.ts under tsconfig.server.json (Node globals
// only), same constraint as chat-timeline.ts (see that file's header comment for why).

/** Minimal shape this module needs from `ChatContext` (client/pr/tab-props.ts), duplicated
 * rather than imported so chat-compose.ts stays decoupled from that file's import graph. */
export interface ComposeContext {
  /** Chip label, e.g. "Module: Analysis · 12 files". Not sent on its own. */
  label: string;
  /** Appended below the user's question on Send. */
  text: string;
}

/**
 * Composes the text actually sent to the agent on Send: the user's question, then — when a
 * context chip is attached — a blank line, a short "Context — <label>:" separator, and the
 * context's own text. Without a context, the question goes out unchanged (trimmed).
 */
export function composeChatMessage(question: string, context: ComposeContext | null | undefined): string {
  const trimmedQuestion = question.trim();
  if (!context) return trimmedQuestion;
  const separator = `Context — ${context.label}:`;
  if (!trimmedQuestion) return `${separator}\n${context.text}`;
  return `${trimmedQuestion}\n\n${separator}\n${context.text}`;
}
