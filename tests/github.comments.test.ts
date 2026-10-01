import { describe, expect, it } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildCreateCommentPayload, registerCommentHandlers } from "../server/github/comments";
import { commentCreateRpc, commentDeleteRpc, commentUpdateRpc } from "../shared/rpc";

describe("buildCreateCommentPayload", () => {
  it("builds the REST JSON shape with commit_id/path/line/side/body", () => {
    const payload = buildCreateCommentPayload({
      path: "src/a.ts",
      line: 42,
      side: "LEFT",
      body: "needs a test",
      commitSha: "abc123",
    });
    expect(payload).toEqual({
      body: "needs a test",
      commit_id: "abc123",
      path: "src/a.ts",
      line: 42,
      side: "LEFT",
    });
  });

  it("passes the side through unchanged for RIGHT", () => {
    const payload = buildCreateCommentPayload({
      path: "src/b.ts",
      line: 7,
      side: "RIGHT",
      body: "nit",
      commitSha: "def456",
    });
    expect(payload.side).toBe("RIGHT");
  });

  it("keeps line as a number, not a stringified value", () => {
    const payload = buildCreateCommentPayload({
      path: "src/c.ts",
      line: 100,
      side: "RIGHT",
      body: "ok",
      commitSha: "ghi789",
    });
    expect(payload.line).toBe(100);
    expect(typeof payload.line).toBe("number");
  });
});

describe("registerCommentHandlers", () => {
  it("registers the three comment RPC contracts", () => {
    const registered: string[] = [];
    const fakeServer = {
      handle: (contract: { name: string }) => {
        registered.push(contract.name);
      },
    } as unknown as PluginServerContext;

    registerCommentHandlers(fakeServer);

    // `.sort()` mutates in place, so compare copies — the second assertion below cares about order.
    expect([...registered].sort()).toEqual(
      [commentCreateRpc.name, commentUpdateRpc.name, commentDeleteRpc.name].sort(),
    );
    expect(registered).toEqual(["prr.comment.create", "prr.comment.update", "prr.comment.delete"]);
  });
});
