import { randomUUID } from "node:crypto";
import type { Job } from "../../shared/types";

export interface JobUpdate {
  stage(stage: string, progress?: number): void;
}

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<() => void>>();
const byKey = new Map<string, string>();

/** How long a finished job's result stays available for polling before it's evicted. */
const JOB_RETENTION_MS = 10 * 60_000;

function notify(id: string) {
  for (const listener of listeners.get(id) ?? []) listener();
}

function evict(id: string, dedupeKey?: string) {
  jobs.delete(id);
  const set = listeners.get(id);
  if (set && set.size === 0) listeners.delete(id);
  if (dedupeKey && byKey.get(dedupeKey) === id) byKey.delete(dedupeKey);
}

/**
 * Start background work and return its job id immediately.
 * `dedupeKey` returns the running job for the same key instead of starting another.
 */
export function startJob(
  kind: string,
  work: (update: JobUpdate) => Promise<unknown>,
  dedupeKey?: string,
): string {
  if (dedupeKey) {
    const existing = byKey.get(dedupeKey);
    const job = existing ? jobs.get(existing) : undefined;
    if (job && (job.status === "queued" || job.status === "running")) return job.id;
  }
  const id = randomUUID();
  const job: Job = {
    id,
    kind,
    status: "running",
    stage: "starting",
    progress: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  if (dedupeKey) byKey.set(dedupeKey, id);
  const update: JobUpdate = {
    stage(stage, progress) {
      job.stage = stage;
      if (progress !== undefined) job.progress = Math.max(0, Math.min(1, progress));
      notify(id);
    },
  };
  void Promise.resolve()
    .then(() => work(update))
    .then(
      (result) => {
        job.status = "done";
        job.progress = 1;
        job.stage = "done";
        job.result = result;
      },
      (error: unknown) => {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        console.error(`[pr-review] job ${kind} failed:`, error);
      },
    )
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      notify(id);
      const evictTimer = setTimeout(() => evict(id, dedupeKey), JOB_RETENTION_MS);
      (evictTimer as unknown as { unref?: () => void }).unref?.();
    });
  return id;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

/** Long-poll: resolves when the job changes or `waitMs` elapses. */
export async function pollJob(id: string, waitMs = 0): Promise<Job> {
  const job = jobs.get(id);
  if (!job) throw new Error(`Unknown job ${id}`);
  if (waitMs <= 0 || job.status === "done" || job.status === "error") return { ...job };
  await new Promise<void>((resolve) => {
    const set = listeners.get(id) ?? new Set();
    listeners.set(id, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) listeners.delete(id);
      resolve();
    };
    const timer = setTimeout(done, Math.min(waitMs, 20_000));
    set.add(done);
  });
  return { ...jobs.get(id)! };
}
