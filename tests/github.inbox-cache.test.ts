import { describe, expect, it, vi } from "vitest";
import { createInboxCache, type InboxCacheDeps, type InboxCacheValue } from "../server/github/inbox-cache";

const STALE_MS = 60_000;

function makeValue(overrides: Partial<InboxCacheValue> = {}): InboxCacheValue {
  return { viewer: "octocat", prs: [], fetchedAt: new Date(0).toISOString(), errors: [], ...overrides };
}

/** Builds a cache with a mutable clock and no-op disk persistence by default, so each test only
 * has to override what it cares about (usually just `fetch`, sometimes `load`). */
function makeCache(overrides: Partial<InboxCacheDeps> = {}) {
  let now = 0;
  const deps: InboxCacheDeps = {
    fetch: vi.fn(async () => makeValue()),
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    now: () => now,
    staleMs: STALE_MS,
    ...overrides,
  };
  return { cache: createInboxCache(deps), deps, setNow: (v: number) => (now = v) };
}

/** A promise plus its resolver, captured outside the executor so a mock can hand back `promise`
 * immediately and a test can settle it later. (A `let resolve: Fn | null` reassigned only inside
 * the executor closure would work at runtime, but TS's control-flow narrowing doesn't see through
 * the closure and narrows the variable to `null` at every later call site.) */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Polls `cache.get()` (real microtasks, no fake timers — same style as `tests/core.jobs.test.ts`)
 * until the served value satisfies `matches`, which is how the tests observe a fire-and-forget
 * background refresh finishing without reaching into the module's private state. */
async function waitForValue(
  cache: { get: (refresh?: boolean) => Promise<{ value: InboxCacheValue; refreshing: boolean }> },
  matches: (v: InboxCacheValue) => boolean,
) {
  for (let i = 0; i < 50; i++) {
    const result = await cache.get();
    if (matches(result.value)) return result;
    await Promise.resolve();
  }
  throw new Error("value never reached the expected state");
}

describe("createInboxCache", () => {
  it("cold start: awaits a fetch when there is no snapshot in memory or on disk", async () => {
    const fresh = makeValue({ fetchedAt: new Date(0).toISOString() });
    const { cache, deps } = makeCache({ fetch: vi.fn(async () => fresh) });

    const result = await cache.get();

    expect(result).toEqual({ value: fresh, refreshing: false });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith(fresh);
  });

  it("fresh hit: serves the cached snapshot without fetching again", async () => {
    const fresh = makeValue({ fetchedAt: new Date(0).toISOString() });
    const { cache, deps, setNow } = makeCache({ fetch: vi.fn(async () => fresh) });

    await cache.get(); // cold start populates memory
    setNow(10_000); // well under staleMs

    const result = await cache.get();

    expect(result).toEqual({ value: fresh, refreshing: false });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("stale hit: returns the old snapshot immediately and coalesces concurrent callers onto exactly one refresh", async () => {
    const first = makeValue({ fetchedAt: new Date(0).toISOString() });
    const second = makeValue({ fetchedAt: new Date(70_000).toISOString(), viewer: "refreshed" });
    let calls = 0;
    const secondFetch = deferred<InboxCacheValue>();
    const fetch = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(first);
      return secondFetch.promise;
    });
    const { cache, deps, setNow } = makeCache({ fetch });

    await cache.get(); // cold start -> memory = first
    setNow(70_000); // >= staleMs past first.fetchedAt

    // Two callers race while the snapshot is stale.
    const [r1, r2] = await Promise.all([cache.get(), cache.get()]);

    expect(r1).toEqual({ value: first, refreshing: true });
    expect(r2).toEqual({ value: first, refreshing: true });
    expect(calls).toBe(2); // one cold-start fetch + exactly one coalesced background refresh

    secondFetch.resolve(second);
    await waitForValue(cache, (v) => v === second);

    expect(calls).toBe(2); // the earlier polling in waitForValue didn't start yet another refresh
    expect(deps.save).toHaveBeenLastCalledWith(second);
  });

  it("forced refresh: awaits a fresh fetch even when the snapshot is still fresh", async () => {
    const first = makeValue({ fetchedAt: new Date(0).toISOString() });
    const second = makeValue({ fetchedAt: new Date(1_000).toISOString(), viewer: "forced" });
    let calls = 0;
    const fetch = vi.fn(async () => (++calls === 1 ? first : second));
    const { cache, deps, setNow } = makeCache({ fetch });

    await cache.get(); // cold start, not stale
    setNow(1_000);

    const result = await cache.get(true);

    expect(result).toEqual({ value: second, refreshing: false });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("forced refresh joins an already in-flight background refresh instead of starting a second one", async () => {
    const first = makeValue({ fetchedAt: new Date(0).toISOString() });
    const second = makeValue({ fetchedAt: new Date(70_000).toISOString(), viewer: "joined" });
    let calls = 0;
    const secondFetch = deferred<InboxCacheValue>();
    const fetch = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(first);
      return secondFetch.promise;
    });
    const { cache, setNow } = makeCache({ fetch });

    await cache.get(); // cold start
    setNow(70_000);
    void cache.get(); // triggers the background refresh, not awaited

    // Let that refresh's fetch() call actually land before joining it below.
    for (let i = 0; i < 10 && calls < 2; i++) await Promise.resolve();

    const forced = cache.get(true); // should join the in-flight refresh, not start a third fetch
    secondFetch.resolve(second);
    const result = await forced;

    expect(result).toEqual({ value: second, refreshing: false });
    expect(calls).toBe(2);
  });

  it("failed refresh keeps the old snapshot and surfaces the error instead of throwing", async () => {
    const first = makeValue({ fetchedAt: new Date(0).toISOString(), errors: [] });
    const fetch = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("GraphQL exploded"));
    const { cache, deps, setNow } = makeCache({ fetch });

    await cache.get(); // cold start -> memory = first
    setNow(1_000); // still fresh; use a forced refresh to deterministically await the failure

    const result = await cache.get(true);

    expect(result.refreshing).toBe(false);
    expect(result.value.viewer).toBe(first.viewer);
    expect(result.value.errors).toEqual(["Could not refresh the inbox: GraphQL exploded"]);
    // The failed fetch must never overwrite the good snapshot on disk.
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith(first);
  });

  it("repeated failed refreshes replace the previous refresh error instead of stacking them", async () => {
    const first = makeValue({ errors: ["Repo foo/bar has no github.com remote"] });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("offline 1"))
      .mockRejectedValueOnce(new Error("offline 2"));
    const { cache } = makeCache({ fetch });

    await cache.get();
    await cache.get(true);
    const result = await cache.get(true);

    expect(result.value.errors).toEqual(["Repo foo/bar has no github.com remote", "Could not refresh the inbox: offline 2"]);
  });

  it("a failed fetch with no snapshot to fall back on propagates the error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("no network"));
    const { cache } = makeCache({ fetch });

    await expect(cache.get()).rejects.toThrow("no network");
  });

  it("loads the persisted snapshot from disk on the first call only", async () => {
    const persisted = makeValue({ fetchedAt: new Date(0).toISOString(), viewer: "from-disk" });
    const fetch = vi.fn(async () => makeValue({ viewer: "should-not-be-called" }));
    const { cache, deps, setNow } = makeCache({ fetch, load: vi.fn(async () => persisted) });

    setNow(0); // the persisted snapshot is fresh relative to "now"
    const result = await cache.get();

    expect(result).toEqual({ value: persisted, refreshing: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.load).toHaveBeenCalledTimes(1);

    await cache.get();
    await cache.get();
    expect(deps.load).toHaveBeenCalledTimes(1); // never re-read after the first attempt
  });

  it("a stale persisted snapshot is served immediately and triggers a background refresh", async () => {
    const persisted = makeValue({ fetchedAt: new Date(0).toISOString(), viewer: "stale-from-disk" });
    const refreshed = makeValue({ fetchedAt: new Date(70_000).toISOString(), viewer: "fresh-now" });
    const fetch = vi.fn(async () => refreshed);
    const { cache, setNow } = makeCache({ fetch, load: vi.fn(async () => persisted) });

    setNow(70_000); // older than staleMs relative to the persisted snapshot's fetchedAt

    const result = await cache.get();
    expect(result).toEqual({ value: persisted, refreshing: true });

    await waitForValue(cache, (v) => v === refreshed);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a save failure is logged and doesn't stop the refreshed value from being served", async () => {
    const fresh = makeValue({ fetchedAt: new Date(0).toISOString() });
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { cache } = makeCache({ fetch: vi.fn(async () => fresh), save });

    const result = await cache.get();

    expect(result).toEqual({ value: fresh, refreshing: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
