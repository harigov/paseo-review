import { describe, expect, it } from "vitest";
import { CommandError, run } from "../server/core/exec";

describe("run()", () => {
  it("does not crash the process when a large stdin payload is written to a command that exits immediately", async () => {
    // Before the fix, `child.stdin.end(bigInput)` against a process that exits without reading
    // stdin emitted an unlistened EPIPE 'error' on the stream, which crashes the whole Node
    // process. If this test file completes at all, the process survived; we also assert the
    // call rejects cleanly instead of hanging or throwing an uncaught exception.
    const bigInput = "x".repeat(300_000); // comfortably over the ~64KB pipe-buffer threshold
    await expect(run("false", [], { input: bigInput })).rejects.toBeInstanceOf(CommandError);
  });

  it("reports a distinct timedOut reason instead of a bare non-zero exit code", async () => {
    await expect(run("sleep", ["5"], { timeoutMs: 50 })).rejects.toMatchObject({
      message: expect.stringContaining("timed out"),
      result: expect.objectContaining({ timedOut: true }),
    });
  });

  it("does not set timedOut for an ordinary failure", async () => {
    await expect(run("false", [])).rejects.toMatchObject({
      result: expect.objectContaining({ timedOut: false }),
    });
  });

  it("marks truncated when stdout exceeds maxBuffer", async () => {
    // Truncation is checked per stdout `data` event, so force several separate chunks.
    const result = await run("sh", ["-c", "for i in 1 2 3; do printf 'abcde'; sleep 0.05; done"], {
      maxBuffer: 4,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(5);
  });

  it("resolves normally for a well-behaved command", async () => {
    const result = await run("sh", ["-c", "echo hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});
