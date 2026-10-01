import { useMemo, useSyncExternalStore } from "react";

/** A draft review comment, kept client-side until the review is submitted. */
export interface DraftComment {
  /** Stable id (incrementing counter) so UI rows can key on it even as the list is edited. */
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Shape of a new draft before `addDraft` stamps it with a stable id. */
export type NewDraftComment = Omit<DraftComment, "id">;

type Key = string;

let nextDraftId = 1;

// Keyed by head SHA too: a draft's `line`/`side` only makes sense against the diff it was
// written against. If the PR is force-pushed or rebased, line numbers can shift — keying by
// head SHA means drafts from a previous head simply stop showing up (see dropStaleDrafts).
function keyOf(repo: string, number: number, headSha: string): Key {
  return `${repo}#${number}#${headSha}`;
}

function prefixOf(repo: string, number: number): string {
  return `${repo}#${number}#`;
}

const store = new Map<Key, DraftComment[]>();
const listeners = new Map<Key, Set<() => void>>();

function emit(key: Key): void {
  const set = listeners.get(key);
  if (!set) return;
  set.forEach((listener) => listener());
}

export function addDraft(repo: string, number: number, headSha: string, draft: NewDraftComment): DraftComment {
  const key = keyOf(repo, number, headSha);
  const withId: DraftComment = { ...draft, id: nextDraftId++ };
  store.set(key, [...(store.get(key) ?? []), withId]);
  emit(key);
  return withId;
}

export function removeDraft(repo: string, number: number, headSha: string, index: number): void {
  const key = keyOf(repo, number, headSha);
  store.set(
    key,
    (store.get(key) ?? []).filter((_draft, position) => position !== index),
  );
  emit(key);
}

/** Updates a draft's body in place (e.g. from the review-submit modal or the diff composer). */
export function updateDraft(repo: string, number: number, headSha: string, index: number, body: string): void {
  const key = keyOf(repo, number, headSha);
  store.set(
    key,
    (store.get(key) ?? []).map((draft, position) => (position === index ? { ...draft, body } : draft)),
  );
  emit(key);
}

export function clearDrafts(repo: string, number: number, headSha: string): void {
  const key = keyOf(repo, number, headSha);
  store.set(key, []);
  emit(key);
}

/**
 * Drops any drafts left over from a previous head for this PR (e.g. after a force-push or
 * rebase changed line numbers) and returns how many were discarded, so the caller can warn.
 */
export function dropStaleDrafts(repo: string, number: number, currentHeadSha: string): number {
  const prefix = prefixOf(repo, number);
  const currentKey = keyOf(repo, number, currentHeadSha);
  let discarded = 0;
  for (const key of [...store.keys()]) {
    if (!key.startsWith(prefix) || key === currentKey) continue;
    discarded += store.get(key)?.length ?? 0;
    store.delete(key);
    emit(key);
  }
  return discarded;
}

const EMPTY: DraftComment[] = [];

/** Live drafts for one PR at its current head; re-renders the caller whenever they change. */
export function useDrafts(repo: string, number: number, headSha: string): DraftComment[] {
  const key = keyOf(repo, number, headSha);
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    () => store.get(key) ?? EMPTY,
  );
}

/** Live drafts for one file within a PR at its current head (e.g. for the diff viewer). */
export function useFileDrafts(repo: string, number: number, headSha: string, path: string): DraftComment[] {
  const drafts = useDrafts(repo, number, headSha);
  return useMemo(() => drafts.filter((draft) => draft.path === path), [drafts, path]);
}
