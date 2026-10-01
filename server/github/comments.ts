import type { PluginServerContext } from "@getpaseo/plugin/server";
import { run } from "../core/exec";
import { handle } from "../core/handle";
import { commentCreateRpc, commentDeleteRpc, commentUpdateRpc } from "../../shared/rpc";
import { errorMessage, gqlString, graphql, splitRepo } from "./gh";
import { invalidatePr, requireRepo } from "./index";

/** Fields `buildCreateCommentPayload` needs — a slice of `commentCreateRpc`'s input. */
export interface CreateCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  commitSha: string;
}

export interface CreateCommentPayload {
  body: string;
  commit_id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

/**
 * Pure REST payload builder for posting a single (non-review) PR comment via
 * `POST /repos/{owner}/{name}/pulls/{number}/comments`. Kept separate from the handler so the
 * JSON shape can be unit-tested without shelling out to `gh`.
 */
export function buildCreateCommentPayload(input: CreateCommentInput): CreateCommentPayload {
  return {
    body: input.body,
    commit_id: input.commitSha,
    path: input.path,
    line: input.line,
    side: input.side,
  };
}

export function registerCommentHandlers(server: PluginServerContext): void {
  handle(server, commentCreateRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    const { owner, name } = splitRepo(repo.slug);
    try {
      const payload = buildCreateCommentPayload(input);
      const result = await run(
        "gh",
        ["api", `repos/${owner}/${name}/pulls/${input.number}/comments`, "-X", "POST", "--input", "-"],
        { timeoutMs: 20_000, input: JSON.stringify(payload) },
      );
      let id: unknown;
      let htmlUrl: unknown;
      try {
        const parsed = JSON.parse(result.stdout) as { id?: unknown; html_url?: unknown };
        id = parsed.id;
        htmlUrl = parsed.html_url;
      } catch {
        id = undefined;
        htmlUrl = undefined;
      }
      invalidatePr(repo.slug, input.number);
      return {
        id: typeof id === "number" || typeof id === "string" ? String(id) : "",
        url: typeof htmlUrl === "string" ? htmlUrl : null,
      };
    } catch (error) {
      throw new Error(`Could not post the comment: ${errorMessage(error)}`);
    }
  });

  handle(server, commentUpdateRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    try {
      await graphql(
        `mutation { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: ${gqlString(input.commentId)}, body: ${gqlString(input.body)} }) { clientMutationId } }`,
      );
      invalidatePr(repo.slug, input.number);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  handle(server, commentDeleteRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    try {
      await graphql(
        `mutation { deletePullRequestReviewComment(input: { id: ${gqlString(input.commentId)} }) { clientMutationId } }`,
      );
      invalidatePr(repo.slug, input.number);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}
