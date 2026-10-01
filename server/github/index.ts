import type { PluginServerContext } from "@getpaseo/plugin/server";
import { run } from "../core/exec";
import { handle } from "../core/handle";
import { waitForPaseo } from "../core/paseo";
import { getSettings } from "../core/settings";
import { services, type GitHubService } from "../core/services";
import {
  fileViewedRpc,
  inboxListRpc,
  prGetRpc,
  reposListRpc,
  reviewSubmitRpc,
  threadReplyRpc,
} from "../../shared/rpc";
import type {
  InboxSection,
  PrDetail,
  PrFile,
  PrSummary,
  Repo,
  Thread,
  ViewedState,
} from "../../shared/types";
import { errorMessage, gqlString, graphql, graphqlWithVars, parseGithubSlug, splitRepo } from "./gh";
import { recordViewed, removeViewed } from "./viewed-store";

type ChecksState = "success" | "failure" | "pending" | "none";
type ReviewDecisionValue = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";

// ---------- small helpers ----------

function mapSearchChecks(state: string | null | undefined): ChecksState {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function mapCheckRunState(status: string | null | undefined, conclusion: string | null | undefined): ChecksState {
  if (conclusion) {
    if (conclusion === "SUCCESS") return "success";
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      return "failure";
    }
    return "none";
  }
  if (status && status !== "COMPLETED") return "pending";
  return "none";
}

function mapReviewDecision(decision: string | null | undefined): ReviewDecisionValue {
  if (decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") return decision;
  return "NONE";
}

// ---------- gh viewer ----------

let viewerCache: { at: number; value: string } | null = null;
const VIEWER_TTL_MS = 10 * 60_000;

async function getViewer(): Promise<string> {
  if (viewerCache && Date.now() - viewerCache.at < VIEWER_TTL_MS) return viewerCache.value;
  const result = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 });
  const login = result.stdout.trim();
  viewerCache = { at: Date.now(), value: login };
  return login;
}

// ---------- repos ----------

let reposCache: { at: number; value: { repos: Repo[]; errors: string[] } } | null = null;
const REPOS_TTL_MS = 60_000;

async function fetchRepos(): Promise<{ repos: Repo[]; errors: string[] }> {
  const errors: string[] = [];
  const repos: Repo[] = [];

  let projects: unknown[];
  try {
    const paseo = await waitForPaseo();
    const result = await paseo.projects.list();
    projects = (result as { projects?: unknown[] }).projects ?? [];
  } catch (error) {
    errors.push(`Could not list Paseo projects: ${errorMessage(error)}`);
    return { repos, errors };
  }

  const settings = await getSettings();

  await Promise.all(
    projects.map(async (raw) => {
      const project = raw as Record<string, unknown>;
      const kind = (project.projectKind ?? project.kind) as string | undefined;
      if (kind === "non_git" || kind === "directory") return;
      const rootPath = (project.projectRootPath ?? project.path) as string | undefined;
      const projectId = (project.projectId ?? project.id) as string | undefined;
      const projectName = (project.projectDisplayName ?? project.name ?? "") as string;
      if (!rootPath || !projectId) return;

      let remoteUrl: string | null = null;
      for (const remote of ["origin", "upstream"]) {
        try {
          const result = await run("git", ["-C", rootPath, "remote", "get-url", remote], {
            timeoutMs: 5_000,
            allowFailure: true,
          });
          if (result.code === 0 && result.stdout.trim()) {
            remoteUrl = result.stdout.trim();
            break;
          }
        } catch {
          // try the next remote
        }
      }
      if (!remoteUrl) return;
      const slug = parseGithubSlug(remoteUrl);
      if (!slug) return;
      const fullSlug = `${slug.owner}/${slug.name}`;
      repos.push({
        slug: fullSlug,
        owner: slug.owner,
        name: slug.name,
        projectId,
        projectName,
        rootPath,
        decisionsEnabled: settings.decisionRepos.includes(fullSlug),
      });
    }),
  );

  return { repos, errors };
}

async function listRepos(): Promise<{ repos: Repo[]; errors: string[] }> {
  if (reposCache && Date.now() - reposCache.at < REPOS_TTL_MS) return reposCache.value;
  const value = await fetchRepos();
  reposCache = { at: Date.now(), value };
  return value;
}

async function findRepo(slug: string): Promise<Repo | null> {
  const { repos } = await listRepos();
  return repos.find((repo) => repo.slug === slug) ?? null;
}

// ---------- inbox ----------

interface SearchPrNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author: { login: string; avatarUrl: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  repository: { nameWithOwner: string };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
  reviewThreads: { nodes: Array<{ isResolved: boolean }> };
}

function buildSummaryFromSearchNode(node: SearchPrNode): PrSummary {
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? "ghost",
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    isDraft: !!node.isDraft,
    state: node.state,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    reviewDecision: mapReviewDecision(node.reviewDecision),
    checks: mapSearchChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null),
    unresolvedThreads: (node.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    baseRef: node.baseRefName,
    headRef: node.headRefName,
    headSha: node.headRefOid,
    sections: [],
    changeType: null,
    severity: null,
    attention: null,
    changedSinceMyReview: null,
  };
}

const PR_SEARCH_FRAGMENT = `
  fragment prFields on PullRequest {
    number title url isDraft state createdAt updatedAt additions deletions changedFiles
    reviewDecision baseRefName headRefName headRefOid
    author { login avatarUrl }
    labels(first: 10) { nodes { name } }
    repository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviewThreads(first: 100) { nodes { isResolved } }
  }
`;

const INBOX_QUERY = `
  query($qMine: String!, $qReview: String!, $qAssigned: String!, $qAll: String!) {
    mine: search(type: ISSUE, first: 50, query: $qMine) { nodes { ... on PullRequest { ...prFields } } }
    reviewRequested: search(type: ISSUE, first: 50, query: $qReview) { nodes { ... on PullRequest { ...prFields } } }
    assigned: search(type: ISSUE, first: 50, query: $qAssigned) { nodes { ... on PullRequest { ...prFields } } }
    all: search(type: ISSUE, first: 50, query: $qAll) { nodes { ... on PullRequest { ...prFields } } }
  }
  ${PR_SEARCH_FRAGMENT}
`;

interface InboxCacheValue {
  viewer: string;
  prs: PrSummary[];
  fetchedAt: string;
  errors: string[];
}

let inboxCache: { at: number; value: InboxCacheValue } | null = null;
const INBOX_TTL_MS = 30_000;

async function listInbox(refresh?: boolean): Promise<InboxCacheValue> {
  if (!refresh && inboxCache && Date.now() - inboxCache.at < INBOX_TTL_MS) return inboxCache.value;

  const errors: string[] = [];
  const { repos, errors: repoErrors } = await listRepos();
  errors.push(...repoErrors);

  let viewer = "";
  try {
    viewer = await getViewer();
  } catch (error) {
    errors.push(`Could not determine the GitHub viewer (is \`gh auth login\` set up?): ${errorMessage(error)}`);
  }

  if (!repos.length || !viewer) {
    const value: InboxCacheValue = { viewer, prs: [], fetchedAt: new Date().toISOString(), errors };
    inboxCache = { at: Date.now(), value };
    return value;
  }

  const repoFilter = repos.map((r) => `repo:${r.slug}`).join(" ");
  const sections: Record<InboxSection, string> = {
    mine: `is:pr is:open author:@me ${repoFilter}`,
    review_requested: `is:pr is:open review-requested:@me ${repoFilter}`,
    assigned: `is:pr is:open assignee:@me ${repoFilter}`,
    all: `is:pr is:open ${repoFilter} sort:updated-desc`,
  };

  const merged = new Map<string, PrSummary>();
  try {
    const data = await graphqlWithVars<{
      mine: { nodes: SearchPrNode[] };
      reviewRequested: { nodes: SearchPrNode[] };
      assigned: { nodes: SearchPrNode[] };
      all: { nodes: SearchPrNode[] };
    }>(INBOX_QUERY, {
      qMine: sections.mine,
      qReview: sections.review_requested,
      qAssigned: sections.assigned,
      qAll: sections.all,
    });

    const bySection: Array<[InboxSection, SearchPrNode[]]> = [
      ["mine", data.mine?.nodes ?? []],
      ["review_requested", data.reviewRequested?.nodes ?? []],
      ["assigned", data.assigned?.nodes ?? []],
      ["all", data.all?.nodes ?? []],
    ];
    for (const [section, nodes] of bySection) {
      for (const node of nodes) {
        const key = `${node.repository.nameWithOwner}#${node.number}`;
        let summary = merged.get(key);
        if (!summary) {
          summary = buildSummaryFromSearchNode(node);
          merged.set(key, summary);
        }
        if (!summary.sections.includes(section)) summary.sections.push(section);
      }
    }
  } catch (error) {
    errors.push(`Could not load the GitHub inbox: ${errorMessage(error)}`);
    if (inboxCache) return inboxCache.value;
  }

  const value: InboxCacheValue = {
    viewer,
    prs: [...merged.values()],
    fetchedAt: new Date().toISOString(),
    errors,
  };
  inboxCache = { at: Date.now(), value };
  return value;
}

// ---------- PR detail ----------

interface CheckRunContext {
  __typename: "CheckRun";
  name: string;
  conclusion: string | null;
  status: string | null;
  url: string | null;
}
interface StatusContextEntry {
  __typename: "StatusContext";
  context: string;
  state: string | null;
  targetUrl: string | null;
}

interface PrQueryResult {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: { login: string; avatarUrl: string } | null;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  baseRefOid: string;
  body: string | null;
  labels: { nodes: Array<{ name: string }> } | null;
  commits: {
    totalCount: number;
    nodes: Array<{ commit: { statusCheckRollup: { state: string | null; contexts: { nodes: Array<CheckRunContext | StatusContextEntry> } } | null } }>;
  };
  files: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ path: string; additions: number; deletions: number; changeType: string; viewerViewedState: string }>;
  };
  reviewThreads: {
    nodes: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      diffSide: "LEFT" | "RIGHT" | null;
      comments: { nodes: Array<{ id: string; author: { login: string } | null; body: string; createdAt: string; url: string }> };
    }>;
  };
  reviews: { nodes: Array<{ submittedAt: string | null; author: { login: string } | null; commit: { oid: string } | null }> };
}

function buildPrQuery(owner: string, name: string, number: number, after: string | null): string {
  const afterClause = after ? `, after: ${gqlString(after)}` : "";
  return `
    query {
      repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) {
        pullRequest(number: ${number}) {
          id number title url state isDraft
          author { login avatarUrl }
          createdAt updatedAt additions deletions changedFiles reviewDecision
          baseRefName headRefName headRefOid baseRefOid
          body
          labels(first: 10) { nodes { name } }
          commits(last: 1) {
            totalCount
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 50) {
                    nodes {
                      __typename
                      ... on CheckRun { name conclusion status url }
                      ... on StatusContext { context state targetUrl }
                    }
                  }
                }
              }
            }
          }
          files(first: 100${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes { path additions deletions changeType viewerViewedState }
          }
          reviewThreads(first: 100) {
            nodes {
              id isResolved isOutdated path line originalLine diffSide
              comments(first: 50) { nodes { id author { login } body createdAt url } }
            }
          }
          reviews(last: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
            nodes { submittedAt author { login } commit { oid } }
          }
        }
      }
    }
  `;
}

const FILE_CAP = 3000;

async function fetchPrDetail(repo: string, number: number): Promise<PrDetail> {
  const { owner, name } = splitRepo(repo);
  const viewer = await getViewer();

  let basePr: PrQueryResult | null = null;
  const files: PrQueryResult["files"]["nodes"] = [];
  let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const raw = await graphql(buildPrQuery(owner, name, number, after));
    const data = raw as { repository: { pullRequest: PrQueryResult | null } | null };
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error(`Pull request ${repo}#${number} was not found on GitHub.`);
    if (!basePr) basePr = pr;
    files.push(...(pr.files?.nodes ?? []));
    const pageInfo = pr.files?.pageInfo;
    if (!pageInfo?.hasNextPage || files.length >= FILE_CAP) break;
    after = pageInfo.endCursor;
  }
  if (!basePr) throw new Error(`Pull request ${repo}#${number} was not found on GitHub.`);

  const threads: Thread[] = (basePr.reviewThreads?.nodes ?? []).map((t) => ({
    id: t.id,
    path: t.path,
    line: t.line ?? null,
    originalLine: t.originalLine ?? null,
    diffSide: t.diffSide ?? "RIGHT",
    isResolved: !!t.isResolved,
    isOutdated: !!t.isOutdated,
    comments: (t.comments?.nodes ?? []).map((c) => ({
      id: c.id,
      author: c.author?.login ?? "ghost",
      body: c.body ?? "",
      createdAt: c.createdAt,
      url: c.url,
    })),
    triage: null,
    triageProbability: null,
  }));

  const mappedFiles: PrFile[] = files.slice(0, FILE_CAP).map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    changeType: f.changeType,
    viewed: (f.viewerViewedState ?? "UNVIEWED") as ViewedState,
  }));

  const contexts = basePr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = contexts.map((c) => {
    if (c.__typename === "CheckRun") {
      return { name: c.name, state: mapCheckRunState(c.status, c.conclusion), url: c.url ?? null };
    }
    return { name: c.context, state: mapSearchChecks(c.state), url: c.targetUrl ?? null };
  });

  const myReviews = (basePr.reviews?.nodes ?? [])
    .filter((r) => r.author?.login && r.author.login.toLowerCase() === viewer.toLowerCase())
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const myLastReviewSha = myReviews.length ? myReviews[myReviews.length - 1]?.commit?.oid ?? null : null;

  const unresolvedThreads = threads.filter((t) => !t.isResolved).length;
  const summary: PrSummary = {
    repo,
    number: basePr.number,
    title: basePr.title,
    url: basePr.url,
    author: basePr.author?.login ?? "ghost",
    authorAvatarUrl: basePr.author?.avatarUrl ?? null,
    isDraft: !!basePr.isDraft,
    state: basePr.state,
    createdAt: basePr.createdAt,
    updatedAt: basePr.updatedAt,
    additions: basePr.additions,
    deletions: basePr.deletions,
    changedFiles: basePr.changedFiles,
    reviewDecision: mapReviewDecision(basePr.reviewDecision),
    checks: mapSearchChecks(basePr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null),
    unresolvedThreads,
    labels: (basePr.labels?.nodes ?? []).map((l) => l.name),
    baseRef: basePr.baseRefName,
    headRef: basePr.headRefName,
    headSha: basePr.headRefOid,
    sections: [],
    changeType: null,
    severity: null,
    attention: null,
    changedSinceMyReview: null,
  };

  return {
    summary,
    body: basePr.body ?? "",
    nodeId: basePr.id,
    baseSha: basePr.baseRefOid,
    commits: basePr.commits?.totalCount ?? 0,
    viewer,
    myLastReviewSha,
    files: mappedFiles,
    threads,
    checks,
  };
}

const prCache = new Map<string, { at: number; value: PrDetail }>();
const prRefCache = new Map<string, { nodeId: string; headSha: string }>();
const PR_TTL_MS = 20_000;

async function getPr(repo: string, number: number, refresh?: boolean): Promise<PrDetail> {
  const key = `${repo}#${number}`;
  if (!refresh) {
    const cached = prCache.get(key);
    if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.value;
  }
  const detail = await fetchPrDetail(repo, number);
  prCache.set(key, { at: Date.now(), value: detail });
  prRefCache.set(key, { nodeId: detail.nodeId, headSha: detail.summary.headSha });
  return detail;
}

async function getPrRef(repo: string, number: number): Promise<{ nodeId: string; headSha: string }> {
  const key = `${repo}#${number}`;
  const cachedDetail = prCache.get(key);
  if (cachedDetail) return { nodeId: cachedDetail.value.nodeId, headSha: cachedDetail.value.summary.headSha };
  const cachedRef = prRefCache.get(key);
  if (cachedRef) return cachedRef;
  const { owner, name } = splitRepo(repo);
  const data = await graphql<{ repository: { pullRequest: { id: string; headRefOid: string } | null } | null }>(
    `query { repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) { pullRequest(number: ${number}) { id headRefOid } } }`,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request ${repo}#${number} was not found on GitHub.`);
  const ref = { nodeId: pr.id, headSha: pr.headRefOid };
  prRefCache.set(key, ref);
  return ref;
}

async function setViewed(repo: string, number: number, filePath: string, viewed: boolean): Promise<ViewedState> {
  const ref = await getPrRef(repo, number);
  const mutationField = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  await graphql(
    `mutation { ${mutationField}(input: { pullRequestId: ${gqlString(ref.nodeId)}, path: ${gqlString(filePath)} }) { clientMutationId } }`,
  );
  if (viewed) await recordViewed(repo, number, filePath, ref.headSha);
  else await removeViewed(repo, number, filePath);
  return viewed ? "VIEWED" : "UNVIEWED";
}

// ---------- service + RPC wiring ----------

export function createGitHubService(): GitHubService {
  return {
    listRepos,
    findRepo,
    getViewer,
    listInbox,
    getPr,
    setViewed,
  };
}

export function registerGitHubHandlers(server: PluginServerContext): void {
  handle(server, reposListRpc, async () => services.github.listRepos());

  handle(server, inboxListRpc, async (input) => services.github.listInbox(input.refresh));

  handle(server, prGetRpc, async (input) => services.github.getPr(input.repo, input.number, input.refresh));

  handle(server, fileViewedRpc, async (input) => {
    const viewedState = await services.github.setViewed(input.repo, input.number, input.path, input.viewed);
    return { path: input.path, viewed: viewedState };
  });

  handle(server, reviewSubmitRpc, async (input) => {
    const { owner, name } = splitRepo(input.repo);
    try {
      const result = await run(
        "gh",
        ["api", `repos/${owner}/${name}/pulls/${input.number}/reviews`, "-X", "POST", "--input", "-"],
        {
          timeoutMs: 20_000,
          input: JSON.stringify({ event: input.event, body: input.body, comments: input.comments }),
        },
      );
      let htmlUrl: unknown;
      try {
        htmlUrl = (JSON.parse(result.stdout) as { html_url?: unknown }).html_url;
      } catch {
        htmlUrl = undefined;
      }
      return { url: typeof htmlUrl === "string" ? htmlUrl : null };
    } catch (error) {
      throw new Error(`Could not submit the review: ${errorMessage(error)}`);
    }
  });

  handle(server, threadReplyRpc, async (input) => {
    try {
      await graphql(
        `mutation { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: ${gqlString(input.threadId)}, body: ${gqlString(input.body)} }) { clientMutationId } }`,
      );
      if (input.resolve) {
        await graphql(
          `mutation { resolveReviewThread(input: { threadId: ${gqlString(input.threadId)} }) { clientMutationId } }`,
        );
      }
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}

export { getLocalViewedRecords } from "./viewed-store";
