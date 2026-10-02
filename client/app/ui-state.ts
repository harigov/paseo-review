import { useEffect, useState, useSyncExternalStore } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { uiStateGetRpc, uiStateSetRpc } from "../../shared/rpc";
import {
  DEFAULT_UI_STATE,
  markReviewed as pureMarkReviewed,
  pushRecent,
  type InboxFilters,
  type RecentPr,
  type UiLocation,
  type UiState,
} from "../../shared/ui-state";

// Module-level UI-state store for the PR Review surface. Plugin surfaces (0.10 hosts) mount
// fresh every time the user opens them, which would otherwise always show the inbox — this
// store lives outside React so it survives those remounts for as long as the client bundle
// stays loaded (i.e. the whole app session), while still persisting to the server (prr.ui.get /
// prr.ui.set) so it also survives a full app restart.
//
// Integration notes for the owners of PrScreen.tsx and Inbox.tsx (not edited here):
//   - PrScreen: call `rememberPrTab(repo, number, tabId)` whenever the active tab changes. To
//     pick the initial tab, read `useLastLocation()` once on mount and use its `tab` when the
//     location is this same PR (location.kind === "pr" && location.repo === repo &&
//     location.number === number) — fall back to the current default ("overview") otherwise.
//   - Inbox: call `useRecentPrs()` to render a "Recently opened" section (it's already sorted
//     most-recent-first and capped at 20; each entry carries `reviewedAt` for an "already
//     reviewed" affordance).

let state: UiState = DEFAULT_UI_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setState(next: UiState): void {
  state = next;
  emit();
  schedulePersist();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): UiState {
  return state;
}

// ---------- hydration ----------

/** Guards `prr.ui.get` to once per app session: flips true as soon as the first hydration
 * (success or failure) completes, so later remounts of the root component don't refetch. */
let hydrated = false;
let hydrating: Promise<void> | null = null;

type SetRpcFn = (input: { state: UiState }) => Promise<{ ok: boolean; message: string | null }>;
/** Captured by `useUiStateHydration` so the non-hook helpers below can persist without being
 * hooks themselves. */
let setRpcFn: SetRpcFn | null = null;

/**
 * Call once from a root component (App.tsx). Triggers `prr.ui.get` on first use, hydrating the
 * module store, and keeps the `prr.ui.set` function captured for persistence. Returns
 * `{ ready }`: render a neutral placeholder (not the inbox) until it's true, so a PR the user
 * was reviewing isn't replaced by a flash of the inbox while state is still loading.
 */
export function useUiStateHydration(): { ready: boolean } {
  const getRpc = useRpc(uiStateGetRpc);
  const setRpc = useRpc(uiStateSetRpc);
  const [ready, setReady] = useState(hydrated);

  useEffect(() => {
    setRpcFn = setRpc;
  }, [setRpc]);

  useEffect(() => {
    if (hydrated) {
      setReady(true);
      return;
    }
    if (!hydrating) {
      hydrating = getRpc({})
        .then((result) => {
          state = result.state;
        })
        .catch((error) => {
          console.error("[pr-review] failed to load UI state, starting from defaults:", error);
        })
        .finally(() => {
          hydrated = true;
          emit();
        });
    }
    let cancelled = false;
    hydrating.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // Only ever needs to run once per mount: `hydrated`/`hydrating` are module state, not props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ready };
}

// ---------- persistence (debounced, serialized) ----------

const DEBOUNCE_MS = 400;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let hasPendingChange = false;
/** Chain of in-flight/queued saves, so a second `prr.ui.set` never starts before the first one
 * settles (which could let an older write land after a newer one). */
let pendingSave: Promise<unknown> = Promise.resolve();

function schedulePersist(): void {
  if (!hydrated) return; // don't persist the placeholder default state back over a real one
  hasPendingChange = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersist, DEBOUNCE_MS);
}

function flushPersist(): void {
  persistTimer = null;
  if (!hasPendingChange) return;
  hasPendingChange = false;
  const setRpc = setRpcFn;
  if (!setRpc) return;
  const toSave = state;
  pendingSave = pendingSave
    .then(() => setRpc({ state: toSave }))
    .catch((error) => {
      // Keep the local (in-memory) state as-is on failure; we'll just try again on the next change.
      console.error("[pr-review] failed to persist UI state:", error);
    });
}

// ---------- hooks ----------

/** The live UI state; re-renders the caller whenever it changes. */
export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useLastLocation(): UiLocation {
  return useUiState().lastLocation;
}

/** Most-recently-opened PRs, newest first, capped at 20. */
export function useRecentPrs(): RecentPr[] {
  return useUiState().recentPrs;
}

/** Inbox filters as last left by the user. */
export function useInboxFilters(): InboxFilters {
  return useUiState().inboxFilters;
}

export function rememberInboxFilters(patch: Partial<InboxFilters>): void {
  setState({ ...state, inboxFilters: { ...state.inboxFilters, ...patch } });
}

// ---------- non-hook mutators ----------

export function rememberLocation(location: UiLocation): void {
  setState({ ...state, lastLocation: location });
}

export function recordRecentPr(pr: { repo: string; number: number; title: string }): void {
  setState(pushRecent(state, pr, new Date().toISOString()));
}

export function markPrReviewed(repo: string, number: number): void {
  setState(pureMarkReviewed(state, repo, number, new Date().toISOString()));
}

/** Updates `lastLocation.tab` only when the current last location is this same PR (a tab change
 * on a PR that's no longer "current" — e.g. a stale callback after navigating away — is ignored). */
export function rememberPrTab(repo: string, number: number, tab: string): void {
  const loc = state.lastLocation;
  if (loc.kind !== "pr" || loc.repo !== repo || loc.number !== number) return;
  setState({ ...state, lastLocation: { ...loc, tab } });
}
