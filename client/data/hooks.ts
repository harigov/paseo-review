import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  inboxListRpc,
  jobPollRpc,
  prAnalysisRpc,
  prGetRpc,
  reposListRpc,
} from "../../shared/rpc";
import type { Job } from "../../shared/types";

/** Repos registered as Paseo projects with a github.com remote. */
export function useRepos() {
  const rpc = useRpc(reposListRpc);
  return useQuery({
    queryKey: ["prr.repos"],
    queryFn: () => rpc({}),
    staleTime: 60_000,
  });
}

/** Inbox list, refetched every 60s; `refresh()` forces a hard refresh (refresh:true). */
export function useInbox() {
  const rpc = useRpc(inboxListRpc);
  const queryClient = useQueryClient();
  const queryKey = ["prr.inbox"] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => rpc({}),
    refetchInterval: 60_000,
  });
  const refreshMutation = useMutation({
    mutationFn: () => rpc({ refresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });
  return {
    ...query,
    refreshing: refreshMutation.isPending,
    refresh: () => refreshMutation.mutate(),
  };
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
 */
export function useJobRunner() {
  const poll = useRpc(jobPollRpc);
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  async function run(start: () => Promise<{ jobId: string }>): Promise<Job> {
    setRunning(true);
    runningRef.current = true;
    try {
      const { jobId } = await start();
      let current = await poll({ jobId, waitMs: 15_000 });
      setJob(current);
      while (runningRef.current && current.status !== "done" && current.status !== "error") {
        current = await poll({ jobId, waitMs: 15_000 });
        setJob(current);
      }
      return current;
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  return { run, job, running };
}
