import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../core/paths";
import { pollJob } from "../core/jobs";
import { getPaseo } from "../core/paseo";
import { services } from "../core/services";
import { getSettings } from "../core/settings";

// Precompute scheduler (plan §6.8): runs every `intervalMinutes`, first run 60s after start.
// Picks review-requested / my PRs with a new head SHA, runs analysis sequentially, and — within
// a daily budget — an agent summary. A server contribution only gets `paseo` inside handlers and
// lifecycle hooks, so a run with no captured `paseo` yet is skipped rather than failed.

const FIRST_RUN_DELAY_MS = 60_000;

interface PrecomputeState {
  lastHeadSha: Record<string, string>;
  agentJobsToday: { date: string; count: number };
}

interface PrecomputeStatus {
  enabled: boolean;
  lastRunAt: string | null;
  queued: number;
  agentJobsToday: number;
  lastError: string | null;
}

function stateFile(): string {
  return path.join(dataDir(), "precompute.json");
}

function loadState(): PrecomputeState {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as PrecomputeState;
  } catch {
    return { lastHeadSha: {}, agentJobsToday: { date: "", count: 0 } };
  }
}

function saveState(state: PrecomputeState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("[pr-review] failed to write precompute.json:", error);
  }
}

/** Calendar date on the daemon host's local clock (not UTC), so the daily agent-summary budget
 * resets at the user's local midnight rather than shifting with their UTC offset. */
function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const status: PrecomputeStatus = {
  enabled: true,
  lastRunAt: null,
  queued: 0,
  agentJobsToday: 0,
  lastError: null,
};

export function getPrecomputeStatus(): PrecomputeStatus {
  return { ...status };
}

/** Exported for tests: runs exactly one precompute pass synchronously (no timers), so test code
 * can seed a failure and assert `getPrecomputeStatus().lastError` keeps it (AG5). */
export async function runOnce(): Promise<void> {
  const settings = await getSettings();
  status.enabled = settings.precompute.enabled;
  if (!settings.precompute.enabled) return;

  const paseo = getPaseo();
  if (!paseo) return; // No daemon API captured yet; try again next tick.

  const state = loadState();
  const today = localDateKey(new Date());
  if (state.agentJobsToday.date !== today) state.agentJobsToday = { date: today, count: 0 };
  status.agentJobsToday = state.agentJobsToday.count;

  // Set exactly once below, in `finally`, from whatever happened this run — never cleared
  // unconditionally, so a real failure stays visible on `precomputeStatusRpc` until the next run.
  let runError: string | null = null;

  try {
    const { prs } = await services.github.listInbox();
    const candidates = prs.filter((pr) => {
      if (settings.precompute.skipDrafts && pr.isDraft) return false;
      if (pr.changedFiles > settings.precompute.maxFiles) return false;
      if (!pr.sections.includes("review_requested") && !pr.sections.includes("mine")) return false;
      return state.lastHeadSha[`${pr.repo}#${pr.number}`] !== pr.headSha;
    });
    status.queued = candidates.length;

    for (const pr of candidates) {
      const key = `${pr.repo}#${pr.number}`;
      try {
        const jobId = services.analysis.startAnalysis(pr.repo, pr.number, { reason: "precompute" });
        let job = await pollJob(jobId, 20_000);
        while (job.status === "running" || job.status === "queued") job = await pollJob(jobId, 20_000);
        if (job.status !== "done") continue;

        state.lastHeadSha[key] = pr.headSha;
        saveState(state);

        if (settings.precompute.agentSummaries && state.agentJobsToday.count < settings.precompute.maxAgentJobsPerDay) {
          try {
            await services.agents.runTask({ repo: pr.repo, number: pr.number, task: "summary" });
            state.agentJobsToday.count++;
            status.agentJobsToday = state.agentJobsToday.count;
            saveState(state);
          } catch (error) {
            console.error(`[pr-review] precompute agent summary failed for ${key}:`, error);
            runError = error instanceof Error ? error.message : String(error);
          }
        }
      } catch (error) {
        console.error(`[pr-review] precompute analysis failed for ${key}:`, error);
        runError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    console.error("[pr-review] precompute run failed:", error);
    runError = error instanceof Error ? error.message : String(error);
  } finally {
    status.queued = 0;
    status.lastRunAt = new Date().toISOString();
    status.lastError = runError;
  }
}

/** Starts the precompute scheduler; returns an async function that stops it. The returned
 * function awaits any tick already in flight (the analysis loop can run for a while) before
 * resolving, so callers that tear down shared resources right after (e.g. the MCP server) don't
 * race a still-running precompute pass. */
export function startPrecompute(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const scheduleNext = async () => {
    if (stopped) return;
    const settings = await getSettings().catch(() => null);
    // Re-check: `stop()` may have run while the line above was awaiting.
    if (stopped) return;
    const intervalMs = (settings?.precompute.intervalMinutes ?? 10) * 60_000;
    timer = setTimeout(tick, intervalMs);
  };

  const tick = async () => {
    if (stopped) return;
    const run = runOnce().catch((error) => console.error("[pr-review] precompute tick failed:", error));
    inFlight = run;
    await run;
    await scheduleNext();
  };

  timer = setTimeout(tick, FIRST_RUN_DELAY_MS);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
