import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  inboxListRpc,
  jobPollRpc,
  prAnalysisRpc,
  prGetRpc,
  reposListRpc,
} from "../../shared/rpc";
import type { Job, PrSummary } from "../../shared/types";

/** Repos registered as Paseo projects with a github.com remote. */
export function useRepos() {
  const rpc = useRpc(reposListRpc);
  return useQuery({
    queryKey: ["prr.repos"],
    queryFn: () => rpc({}),
    staleTime: 60_000,
  });
}

/** `prr.inbox.list`'s output (see `shared/rpc.ts`). Duplicated here (rather than derived from
 * the host SDK's RPC types) because client code only imports from `@getpaseo/plugin/client` —
 * the plain `@getpaseo/plugin` specifier isn't resolvable by Paseo's client compiler (see the
 * "Fix plugin install" commit). */
interface InboxSnapshot {
  viewer: string;
  prs: PrSummary[];
  fetchedAt: string;
  errors: string[];
  refreshing: boolean;
}

/** Last inbox response, kept outside React/react-query state so it survives the whole "PR
 * Review" surface remounting (docs/plan-round4.md §1 — every reopen remounts the surface, and
 * without this a remount would flash the skeleton again every time). Scoped to this module
 * instance, i.e. the app session; a daemon restart is covered separately by the server's own
 * on-disk inbox-cache.json. */
let lastInbox: InboxSnapshot | null = null;

/** Bounded fast-poll while the server reports a background refresh in flight, so a stale inbox
 * (served instantly) catches up with fresh data within ~1 minute without polling forever if a
 * refresh stalls. */
const REFRESH_POLL_MS = 3_000;
const MAX_REFRESH_POLLS = 20;
const INBOX_REFETCH_MS = 60_000;

/**
 * Inbox list. Seeded from `lastInbox` as `initialData` (and `initialDataUpdatedAt` from its own
 * `fetchedAt`, so staleness is measured from when it was actually fetched, not from this mount),
 * so a remount renders the last-known list instantly instead of a skeleton. Refetched every 60s;
 * while the response carries `refreshing: true` (the server is revalidating a stale snapshot in
 * the background), polls every ~3s, up to `MAX_REFRESH_POLLS` times, until fresh data lands.
 * `refresh()` forces a hard refresh (refresh:true) and keeps working as before.
 */
export function useInbox() {
  const rpc = useRpc(inboxListRpc);
  const queryClient = useQueryClient();
  const queryKey = ["prr.inbox"] as const;
  // Tracks the bounded fast-poll count for the current snapshot; reset whenever `fetchedAt`
  // moves on, i.e. a new snapshot (background or forced) actually landed.
  const pollRef = useRef({ fetchedAt: "", count: 0 });

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const data = await rpc({});
      lastInbox = data;
      return data;
    },
    initialData: () => lastInbox ?? undefined,
    initialDataUpdatedAt: () => (lastInbox ? Date.parse(lastInbox.fetchedAt) : undefined),
    staleTime: 60_000,
    gcTime: Infinity,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return INBOX_REFETCH_MS;
      if (data.fetchedAt !== pollRef.current.fetchedAt) pollRef.current = { fetchedAt: data.fetchedAt, count: 0 };
      if (data.refreshing && pollRef.current.count < MAX_REFRESH_POLLS) {
        pollRef.current.count += 1;
        return REFRESH_POLL_MS;
      }
      return INBOX_REFETCH_MS;
    },
  });
  const refreshMutation = useMutation({
    mutationFn: () => rpc({ refresh: true }),
    onSuccess: (data) => {
      lastInbox = data;
      queryClient.setQueryData(queryKey, data);
    },
  });
  return {
    ...query,
    refreshing: refreshMutation.isPending,
    refresh: () => refreshMutation.mutate(),
  };
}

/** Looks up a PR's summary from the last loaded inbox snapshot (`lastInbox`, above),
 * case-insensitive on repo. Lets a PR screen render its real header (title, state, refs)
 * immediately while the full detail is still loading — whether opened from the inbox list or
 * reopened as the surface's last-viewed PR. Returns null before any inbox has loaded this
 * session, or if the PR isn't in it (e.g. it was never in the viewer's inbox). */
export function findInboxSummary(repo: string, number: number): PrSummary | null {
  if (!lastInbox) return null;
  const lower = repo.toLowerCase();
  return lastInbox.prs.find((pr) => pr.repo.toLowerCase() === lower && pr.number === number) ?? null;
}

export function usePr(repo: string, number: number, enabled = true) {
  const rpc = useRpc(prGetRpc);
  return useQuery({
    queryKey: ["prr.pr", repo, number],
    queryFn: () => rpc({ repo, number }),
    enabled: enabled && !!repo && Number.isFinite(number),
  });
}

export function useAnalysis(repo: string, number: number, enabled = true) {
  const rpc = useRpc(prAnalysisRpc);
  return useQuery({
    queryKey: ["prr.analysis", repo, number],
    queryFn: () => rpc({ repo, number }),
    enabled: enabled && !!repo && Number.isFinite(number),
  });
}

/**
 * Starts a long-running job and polls it to completion.
 * `run(start)` kicks off `start()` (which must return `{ jobId }`), then polls
 * `prr.job.poll` (15s long-poll) until the job is `done` or `error`.
 *
 * Cancels its own poll loop on unmount (and on `cancel()`), and never calls
 * `setState` after that: the loop checks `runningRef` on every iteration and
 * every state update goes through a mounted guard.
 */
export function useJobRunner() {
  const poll = useRpc(jobPollRpc);
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Unmounting stops the poll loop (runningRef) and blocks further setState.
      mountedRef.current = false;
      runningRef.current = false;
    };
  }, []);

  function setJobIfMounted(next: Job) {
    if (mountedRef.current) setJob(next);
  }
  function setRunningIfMounted(next: boolean) {
    if (mountedRef.current) setRunning(next);
  }

  async function run(start: () => Promise<{ jobId: string }>): Promise<Job> {
    runningRef.current = true;
    setRunningIfMounted(true);
    try {
      const { jobId } = await start();
      let current = await poll({ jobId, waitMs: 15_000 });
      setJobIfMounted(current);
      while (runningRef.current && current.status !== "done" && current.status !== "error") {
        current = await poll({ jobId, waitMs: 15_000 });
        setJobIfMounted(current);
      }
      return current;
    } finally {
      runningRef.current = false;
      setRunningIfMounted(false);
    }
  }

  /** Stops polling after the in-flight poll resolves; does not cancel the job server-side. */
  function cancel() {
    runningRef.current = false;
  }

  return { run, job, running, cancel };
}
