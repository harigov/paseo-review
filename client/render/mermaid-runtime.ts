import { useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { assetGetRpc } from "../../shared/rpc";
import { escapeScriptClose } from "./html-web";

// Loads the mermaid runtime (~3 MB of minified JS, served in ≤512 KiB chunks by
// `server/assets/index.ts` rather than bundled into the client — see docs/plan-round4.md §5)
// once per app session, shared across every renderer that needs it (GithubHtmlView, Markdown's
// MermaidView, HtmlView). Follows the module-level-store-plus-`useSyncExternalStore` shape of
// `client/app/ui-state.ts`, so every mounted consumer re-renders when the shared load settles.

export type MermaidRuntimeStatus = "idle" | "loading" | "ready" | "unavailable";

export interface MermaidRuntimeState {
  status: MermaidRuntimeStatus;
  /** The runtime's own source text once `status` is "ready"; null otherwise. */
  script: string | null;
  /** Set when `status` is "unavailable" (why it couldn't be loaded); null otherwise. */
  message: string | null;
}

const IDLE_STATE: MermaidRuntimeState = { status: "idle", script: null, message: null };

let state: MermaidRuntimeState = IDLE_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setState(next: MermaidRuntimeState): void {
  state = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): MermaidRuntimeState {
  return state;
}

type AssetChunk = { text: string | null; nextOffset: number | null; total: number; message: string | null };
type FetchChunk = (input: { name: "mermaid"; offset: number }) => Promise<AssetChunk>;

// A well-behaved server always either stops (`nextOffset: null`) or advances the offset; this
// just bounds how long a misbehaving one (stuck repeating the same offset) can be followed.
const MAX_CHUNKS = 10_000;

/**
 * Fetches every chunk from offset 0 through `nextOffset` until it is null, concatenating `text`
 * into the full script. Exported standalone (no React, no module-level state) so the loop and
 * its failure modes are unit tested against a fake `fetchChunk`.
 */
export async function loadMermaidScript(fetchChunk: FetchChunk): Promise<{ script: string | null; message: string | null }> {
  const parts: string[] = [];
  let offset = 0;
  let lastMessage: string | null = null;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const chunk = await fetchChunk({ name: "mermaid", offset });
    if (chunk.text === null) {
      return { script: null, message: chunk.message ?? "The mermaid runtime could not be loaded." };
    }
    parts.push(chunk.text);
    lastMessage = chunk.message;
    if (chunk.nextOffset === null) {
      const script = parts.join("");
      if (!script) return { script: null, message: lastMessage ?? "The mermaid runtime is empty." };
      // Escaped once here, centrally, so every consumer that inlines this into a `<script>` tag
      // (GithubHtmlView, HtmlView, MermaidView) is automatically safe against a stray
      // `</script` substring inside the runtime's own (~3 MB, minified, not written by us)
      // source accidentally closing the tag early.
      return { script: escapeScriptClose(script), message: null };
    }
    if (chunk.nextOffset <= offset) {
      return { script: null, message: "The mermaid runtime failed to load (server made no progress)." };
    }
    offset = chunk.nextOffset;
  }
  return { script: null, message: "The mermaid runtime failed to load (too many chunks)." };
}

/** Starts the shared load, if it hasn't already started. Idempotent for the rest of the
 * session: a later call while loading, ready, or unavailable is a no-op. */
let loadStarted = false;
function ensureLoading(fetchChunk: FetchChunk): void {
  if (loadStarted) return;
  loadStarted = true;
  setState({ status: "loading", script: null, message: null });
  loadMermaidScript(fetchChunk)
    .then(({ script, message }) => {
      setState(script ? { status: "ready", script, message: null } : { status: "unavailable", script: null, message });
    })
    .catch((error: unknown) => {
      setState({ status: "unavailable", script: null, message: error instanceof Error ? error.message : String(error) });
    });
}

/**
 * The shared mermaid runtime, loaded lazily and only once per session. `enabled` should be true
 * only when the caller actually has a diagram to render — the runtime is large enough that it
 * should never be fetched just because a renderer that happens to support mermaid is on screen.
 * Once another consumer has triggered the load, every consumer (enabled or not) sees the same
 * shared status as it progresses from "loading" to "ready"/"unavailable".
 */
export function useMermaidRuntime(enabled: boolean): MermaidRuntimeState {
  const fetchChunk = useRpc(assetGetRpc);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (enabled) ensureLoading(fetchChunk);
  }, [enabled, fetchChunk]);
  return snapshot;
}

/** Test-only: resets the module-level load state between unrelated test cases. */
export function resetMermaidRuntimeForTests(): void {
  loadStarted = false;
  state = IDLE_STATE;
}
