import { useSyncExternalStore } from "react";

/** A draft review comment, kept client-side until the review is submitted. */
export interface DraftComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

type Key = string;

function keyOf(repo: string, number: number): Key {
  return `${repo}#${number}`;
}

const store = new Map<Key, DraftComment[]>();
const listeners = new Map<Key, Set<() => void>>();

function emit(key: Key): void {
  const set = listeners.get(key);
  if (!set) return;
  set.forEach((listener) => listener());
}

/** Snapshot read outside React (e.g. before submitting a review). */
export function getDrafts(repo: string, number: number): DraftComment[] {
  return store.get(keyOf(repo, number)) ?? [];
}

export function addDraft(repo: string, number: number, draft: DraftComment): void {
  const key = keyOf(repo, number);
  store.set(key, [...(store.get(key) ?? []), draft]);
  emit(key);
}

export function removeDraft(repo: string, number: number, index: number): void {
  const key = keyOf(repo, number);
  store.set(
    key,
    (store.get(key) ?? []).filter((_draft, position) => position !== index),
  );
  emit(key);
}

export function clearDrafts(repo: string, number: number): void {
  const key = keyOf(repo, number);
  store.set(key, []);
  emit(key);
}

const EMPTY: DraftComment[] = [];

/** Live drafts for one PR; re-renders the caller whenever they change. */
export function useDrafts(repo: string, number: number): DraftComment[] {
  const key = keyOf(repo, number);
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
