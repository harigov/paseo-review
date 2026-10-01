// The `<!-- paseo:html -->…<!-- /paseo:html -->` convention for rich PR descriptions.
// Shared so the server (analysis) and the client (markdown fallback) parse it identically.

const BLOCK = /<!--\s*paseo:html\s*-->([\s\S]*?)(?:<!--\s*\/paseo:html\s*-->|$)/gi;

/** HTML of every rich block, joined; null when the body has none. An unterminated block runs to the end. */
export function extractRichHtml(body: string): string | null {
  const parts = [...body.matchAll(BLOCK)].map((match) => match[1]!.trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/** The body with every rich block removed, so markdown never renders the hidden HTML. */
export function stripRichHtml(body: string): string {
  return body.replace(BLOCK, "").trim();
}
