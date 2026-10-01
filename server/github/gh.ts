import { run } from "../core/exec";

/** Escapes a value for inline use inside a GraphQL document (quoting rules match JSON strings closely enough). */
export function gqlString(value: string): string {
  return JSON.stringify(value);
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const idx = repo.indexOf("/");
  if (idx < 0) throw new Error(`Invalid repo slug "${repo}"; expected "owner/name".`);
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/** Matches github.com, and SSH host aliases like "github.com-work" configured to point at it. */
const GITHUB_HOST_RE = /^(?:[\w.-]+@)?github\.com(?:-[\w.-]+)?$/i;

/** Parses "owner/name" on github.com out of an https, ssh:// or scp-like ("[user@]host:path") remote URL. */
export function parseGithubSlug(remoteUrl: string): { owner: string; name: string } | null {
  const trimmed = remoteUrl.trim();
  let host: string | undefined;
  let pathPart: string | undefined;

  const urlMatch = trimmed.match(/^(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (urlMatch) {
    host = urlMatch[1];
    pathPart = urlMatch[2];
  } else {
    const scpMatch = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (scpMatch) {
      host = scpMatch[1];
      pathPart = scpMatch[2];
    }
  }
  if (!host || !pathPart) return null;
  // Strip an explicit port (e.g. "ssh://git@github.com:22/owner/repo.git") before the host check.
  const hostNoPort = host.replace(/:\d+$/, "");
  if (!GITHUB_HOST_RE.test(hostNoPort)) return null;

  const cleanPath = pathPart.replace(/^\/+/, "").replace(/\.git\/?$/i, "");
  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  return { owner, name };
}

interface GraphqlResponse {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

function parseGraphqlStdout(stdout: string): GraphqlResponse {
  let parsed: GraphqlResponse;
  try {
    parsed = JSON.parse(stdout) as GraphqlResponse;
  } catch {
    throw new Error("GitHub returned an unreadable GraphQL response.");
  }
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  }
  return parsed;
}

/** Runs a `gh api graphql` query/mutation with all values already inlined in `document`. */
export async function graphql<T = unknown>(document: string, timeoutMs = 20_000): Promise<T> {
  const result = await run("gh", ["api", "graphql", "-f", `query=${document}`], { timeoutMs });
  return parseGraphqlStdout(result.stdout).data as T;
}

/** Runs a `gh api graphql` query with string variables (used for search queries built from user text). */
export async function graphqlWithVars<T = unknown>(
  document: string,
  variables: Record<string, string>,
  timeoutMs = 20_000,
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${document}`];
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
  const result = await run("gh", args, { timeoutMs });
  return parseGraphqlStdout(result.stdout).data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
