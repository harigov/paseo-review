import type { PrSummary } from "../../shared/types";

// Stale-while-revalidate core for the inbox (docs/plan-round4.md §1). Pure apart from the
// injected `fetch`/`load`/`save`/`now`: no direct filesystem or network access, so the policy —
// cold start, freshness, coalesced background refresh, forced refresh, failure fallback — is
// unit-testable without touching disk or GitHub. `server/github/index.ts` wires the real GraphQL
// fetch and atomic on-disk persistence into this.

export interface InboxCacheValue {
  viewer: string;
  prs: PrSummary[];
  fetchedAt: string;
  errors: string[];
}

export interface InboxCacheDeps {
  /** Performs one true fetch (GraphQL search + enrichment). Rejects on failure; this module
   * decides whether that's fatal (no snapshot to fall back on) or just logged (one exists). */
  fetch: () => Promise<InboxCacheValue>;
  /** Loads the last persisted snapshot, or null if there is none / it's unreadable. Called at
   * most once, the first time `get` runs with nothing in memory yet. */
  load: () => Promise<InboxCacheValue | null>;
  /** Persists a successful fetch. Callers are expected to do this atomically (tmp file + rename),
   * like `server/ui-state/index.ts`. A save failure is logged and otherwise ignored. */
  save: (value: InboxCacheValue) => Promise<void>;
  now: () => number;
  /** Snapshot age (ms, measured from `value.fetchedAt`) past which `get` starts a background
   * refresh instead of serving the snapshot indefinitely. */
  staleMs: number;
}

export interface InboxCacheResult {
  value: InboxCacheValue;
  refreshing: boolean;
}

const REFRESH_ERROR_PREFIX = "Could not refresh the inbox: ";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createInboxCache(deps: InboxCacheDeps) {
  let memory: InboxCacheValue | null = null;
  let diskLoadAttempted = false;
  let inFlight: Promise<InboxCacheValue> | null = null;

  function age(value: InboxCacheValue): number {
    return deps.now() - Date.parse(value.fetchedAt);
  }

  /** Starts one fetch, coalescing concurrent callers onto the same promise. On success, updates
   * `memory` and persists it. On failure: if a snapshot already exists, it's kept — the fetch
   * error is appended to its `errors` so the next response surfaces it — rather than being
   * overwritten by the failed attempt; the error is logged either way. With nothing to fall back
   * on, the rejection propagates to whoever is awaiting this refresh. */
  function startRefresh(): Promise<InboxCacheValue> {
    if (inFlight) return inFlight;
    const promise = deps
      .fetch()
      .then(async (value) => {
        memory = value;
        try {
          await deps.save(value);
        } catch (error) {
          console.error("[pr-review] failed to persist the inbox cache:", error);
        }
        return value;
      })
      .catch((error) => {
        console.error("[pr-review] inbox refresh failed:", error);
        if (!memory) throw error;
        // Replace (not stack) the previous refresh error: a long outage retries every `staleMs`.
        const kept = memory.errors.filter((message) => !message.startsWith(REFRESH_ERROR_PREFIX));
        memory = { ...memory, errors: [...kept, `${REFRESH_ERROR_PREFIX}${errorMessage(error)}`] };
        return memory;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = promise;
    return promise;
  }

  async function ensureSeeded(): Promise<void> {
    if (memory || diskLoadAttempted) return;
    diskLoadAttempted = true;
    try {
      const disk = await deps.load();
      if (disk) memory = disk;
    } catch (error) {
      console.error("[pr-review] failed to load the persisted inbox cache:", error);
    }
  }

  async function get(refresh?: boolean): Promise<InboxCacheResult> {
    await ensureSeeded();

    if (refresh) {
      // Forced refresh always awaits a fresh fetch; joining an in-flight one is fine.
      const value = await startRefresh();
      return { value, refreshing: false };
    }

    if (!memory) {
      // No snapshot at all (cold start, nothing on disk either): await a fetch.
      const value = await startRefresh();
      return { value, refreshing: false };
    }

    if (age(memory) >= deps.staleMs) {
      // Serve the stale snapshot immediately; kick off exactly one background refresh (coalesced
      // with any already running). Failures are caught above, so this can't reject unobserved.
      void startRefresh();
      return { value: memory, refreshing: true };
    }

    return { value: memory, refreshing: inFlight !== null };
  }

  return { get };
}
