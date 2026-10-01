import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJob, pollJob, startJob } from "../server/core/jobs";

async function waitForStatus(id: string, status: string) {
  // Work is driven by real microtasks even under fake timers; flush a few ticks.
  for (let i = 0; i < 50; i++) {
    if (getJob(id)?.status === status) return;
    await Promise.resolve();
  }
  throw new Error(`job ${id} never reached status ${status}`);
}

describe("jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts a finished job's result after the retention window so it doesn't leak forever", async () => {
    const id = startJob("test-kind", async () => "the-result");
    await waitForStatus(id, "done");
    expect(getJob(id)?.result).toBe("the-result");

    // Just under the retention window: still there.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(getJob(id)).not.toBeNull();

    // Past the retention window: evicted.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(getJob(id)).toBeNull();
  });

  it("starting the same dedupe key again after the first job is evicted starts a fresh job", async () => {
    const id1 = startJob("test-kind", async () => "first", "dedupe-key");
    await waitForStatus(id1, "done");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(getJob(id1)).toBeNull();

    const id2 = startJob("test-kind", async () => "second", "dedupe-key");
    expect(id2).not.toBe(id1);
    await waitForStatus(id2, "done");
    expect(getJob(id2)?.result).toBe("second");
  });

  it("pollJob resolves immediately for an already-finished job without waiting", async () => {
    const id = startJob("test-kind", async () => "done-fast");
    await waitForStatus(id, "done");
    const job = await pollJob(id, 20_000);
    expect(job.status).toBe("done");
  });
});
