import { collectGuidanceFiles } from "./guidance";
import type { Analysis, PrDetail, Repo } from "../../shared/types";

/** The PR context pack handed to agents as their system prompt (plan §8.4): title, url,
 * base/head, body, module map, validator failures, unresolved threads, guidance files. */
export async function buildContextPack(
  repo: Repo,
  number: number,
  pr: PrDetail,
  analysis: Analysis | null,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`# PR context: ${repo.slug}#${number}`);
  lines.push(`Title: ${pr.summary.title}`);
  lines.push(`URL: ${pr.summary.url}`);
  lines.push(`Base: ${pr.summary.baseRef}  Head: ${pr.summary.headRef}`);
  lines.push("");
  lines.push("## Description");
  lines.push((pr.body || "(no description)").slice(0, 6000));

  if (analysis) {
    lines.push("");
    lines.push("## Modules");
    for (const module of analysis.modules) {
      const files = analysis.files.filter((f) => f.moduleId === module.id).map((f) => f.path);
      const shown = files.slice(0, 20).join(", ") + (files.length > 20 ? ", …" : "");
      lines.push(`- ${module.title} (id: ${module.id}): ${shown}`);
    }

    const failing = analysis.validators.filter((v) => v.status === "fail");
    if (failing.length) {
      lines.push("");
      lines.push("## Validator failures");
      for (const v of failing) lines.push(`- ${v.title} (${v.validatorId}): ${v.findings.length} finding(s)`);
    }
  }

  const unresolved = pr.threads.filter((t) => !t.isResolved);
  if (unresolved.length) {
    lines.push("");
    lines.push("## Unresolved threads");
    for (const thread of unresolved.slice(0, 20)) {
      const firstComment = thread.comments[0]?.body?.slice(0, 200) ?? "";
      lines.push(`- ${thread.path}:${thread.line ?? "?"} (id: ${thread.id}) — ${firstComment}`);
    }
  }

  const headSha = analysis?.headSha ?? pr.summary.headSha;
  const touchedPaths = analysis?.files.map((f) => f.path) ?? [];
  const guidanceFiles = await collectGuidanceFiles(repo.slug, headSha, touchedPaths);
  for (const file of guidanceFiles) {
    lines.push("");
    lines.push(`## ${file.path}`);
    lines.push(file.content);
  }

  return lines.join("\n");
}

export function chatInstructions(repo: Repo, number: number, mergeBaseSha: string): string {
  return [
    `You are helping review PR #${number} in ${repo.slug}. Be strictly read-only: don't modify files, commit, or push.`,
    `Base diff: \`git diff ${mergeBaseSha}...HEAD\`.`,
    "Cite file:line when referencing code.",
  ].join("\n");
}
