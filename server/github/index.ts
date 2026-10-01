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
  PrReview,
  PrSummary,
  Repo,
  ReviewRequest,
  ReviewState,
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
    // CheckConclusionState: ACTION_REQUIRED, TIMED_OUT, CANCELLED, FAILURE, STARTUP_FAILURE are
    // failures; NEUTRAL/SKIPPED/STALE fall through to "none" below (there is no "ERROR" value
    // on this enum — that's only on the legacy StatusState used by mapSearchChecks).
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
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

function mapReviewState(state: string | null | undefined): ReviewState {
  if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED" || state === "PENDING") {
    return state;
  }
  return "COMMENTED";
}

/** Group rank for sorting `PrDetail.reviews`: changes-requested, then approved, then everything
 * else (commented/dismissed/pending share a group, newest first within it). */
const REVIEW_STATE_RANK: Record<ReviewState, number> = {
  CHANGES_REQUESTED: 0,
  APPROVED: 1,
  COMMENTED: 2,
  DISMISSED: 2,
  PENDING: 2,
};

interface LatestReviewNode {
  state: string | null;
  submittedAt: string | null;
  url: string | null;
  author: { __typename: string; login: string } | null;
}

/** Maps GitHub's `latestReviews` nodes (one per reviewer) to `PrDetail.reviews`: excludes the PR
 * author's own review and sorts changes-requested first, then approved, then the rest — newest
 * submission first within each group. */
export function mapLatestReviews(nodes: LatestReviewNode[], prAuthor: string): PrReview[] {
  const reviews = nodes
    .filter((n) => (n.author?.login ?? "ghost") !== prAuthor)
    .map((n) => ({
      author: n.author?.login ?? "ghost",
      authorKind: (n.author?.__typename === "Bot" ? "bot" : "user") as PrReview["authorKind"],
      state: mapReviewState(n.state),
      submittedAt: n.submittedAt ?? null,
      url: n.url ?? null,
    }));
  return reviews.sort((a, b) => {
    const byRank = REVIEW_STATE_RANK[a.state] - REVIEW_STATE_RANK[b.state];
    if (byRank !== 0) return byRank;
    const at = a.submittedAt ? Date.parse(a.submittedAt) : 0;
    const bt = b.submittedAt ? Date.parse(b.submittedAt) : 0;
    return bt - at;
  });
}

interface ReviewRequestNode {
  requestedReviewer: { __typename: string; login?: string; name?: string; slug?: string } | null;
}

/** Maps GitHub's `reviewRequests` nodes to `PrDetail.reviewRequests`. Mannequins (unclaimed
 * reviewer placeholders) are reported as users; teams prefer `slug`, falling back to `name`. */
export function mapReviewRequests(nodes: ReviewRequestNode[]): ReviewRequest[] {
  const out: ReviewRequest[] = [];
  for (const node of nodes) {
    const reviewer = node.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === "Team") {
      out.push({ kind: "team", name: reviewer.slug || reviewer.name || "" });
    } else if (reviewer.__typename === "Bot") {
      out.push({ kind: "bot", name: reviewer.login ?? "" });
    } else {
      // User or Mannequin
      out.push({ kind: "user", name: reviewer.login ?? "" });
    }
  }
  return out;
}

/** Small bounded cache: evicts the least-recently-written entry once `maxSize` is exceeded, so
 * long-lived daemon processes don't accumulate one entry per PR/key ever seen. */
class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly maxSize: number) {}
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string): void {
    this.map.delete(key);
  }
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
  const decisionRepos = new Set(settings.decisionRepos.map((s) => s.toLowerCase()));

  await Promise.all(
    projects.map(async (raw) => {
      const project = raw as Record<string, unknown>;
      // `projectKind`/`projectRootPath`/`projectDisplayName`/`projectId` are the real 0.10.2
      // field names (verified against @getpaseo/protocol's WorkspaceProjectDescriptorPayload);
      // the `??` fallbacks are kept only in case an older host sends a different shape.
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
        decisionsEnabled: decisionRepos.has(fullSlug.toLowerCase()),
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

/** Case-insensitive lookup that returns the canonically-cased `Repo` as registered, so a
 * differently-cased RPC input still resolves to one consistent slug for cache keys, GraphQL
 * calls and on-disk file names. */
async function findRepo(slug: string): Promise<Repo | null> {
  const { repos } = await listRepos();
  const lower = slug.toLowerCase();
  return repos.find((repo) => repo.slug.toLowerCase() === lower) ?? null;
}

/** Validates that `slug` is one of the repos registered as a Paseo project (the plan's stated
 * scope) and returns its canonical form. Every github RPC handler must call this before using
 * the caller-supplied repo string for a GraphQL call, a `gh` invocation, or a data-file path. */
export async function requireRepo(slug: string): Promise<Repo> {
  const repo = await findRepo(slug);
  if (!repo) throw new Error(`"${slug}" is not a repo registered as a Paseo project.`);
  return repo;
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
  query($qMine: String!, $qReview: String!, $qAssigned: String!, $qAll: String!, $qRecent: String!) {
    recent: search(type: ISSUE, first: 20, query: $qRecent) { nodes { ... on PullRequest { ...prFields } } }
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

/** Decision-model "needs my attention" score, cached per PR#head so a background fill from one
 * refresh is visible on the next, without ever blocking (or failing) the inbox response. */
const attentionCache = new BoundedCache<{ headSha: string; value: number | null }>(1000);

async function fillAttention(prs: PrSummary[]): Promise<void> {
  const toScore: PrSummary[] = [];
  for (const pr of prs) {
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    const cached = attentionCache.get(key);
    if (cached && cached.headSha === pr.headSha) {
      pr.attention = cached.value;
    } else {
      toScore.push(pr);
    }
  }
  if (!toScore.length) return;
  // Fire-and-forget: a decision-API round trip must never block or fail the inbox RPC. Results
  // land in the cache for the *next* refresh.
  void services.decide
    .attention(toScore)
    .then((scores) => {
      toScore.forEach((pr, i) => {
        attentionCache.set(`${pr.repo.toLowerCase()}#${pr.number}`, { headSha: pr.headSha, value: scores[i] ?? null });
      });
    })
    .catch(() => {
      // best-effort; leave attention null until it succeeds
    });
}

async function fillInboxEnrichment(prs: PrSummary[], repos: Repo[]): Promise<void> {
  const decisionsEnabled = new Map(repos.map((r) => [r.slug.toLowerCase(), r.decisionsEnabled]));
  await Promise.all(
    prs.map(async (pr) => {
      try {
        const enrichment = await services.analysis.getInboxEnrichment(pr.repo, pr.number, pr.headSha);
        if (enrichment) {
          pr.severity = enrichment.severity;
          pr.changeType = enrichment.changeType;
          pr.changedSinceMyReview = enrichment.changedSinceMyReview;
        }
      } catch {
        // Enrichment is a best-effort cache read; never fail the inbox over it.
      }
    }),
  );
  const eligible = prs.filter((pr) => decisionsEnabled.get(pr.repo.toLowerCase()));
  if (eligible.length) await fillAttention(eligible);
}

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
    // Any state: a PR you reviewed last week and that merged since still belongs under "recent".
    recent: `is:pr reviewed-by:@me -author:@me ${repoFilter} sort:updated-desc`,
    mine: `is:pr is:open author:@me ${repoFilter}`,
    review_requested: `is:pr is:open review-requested:@me ${repoFilter}`,
    assigned: `is:pr is:open assignee:@me ${repoFilter}`,
    all: `is:pr is:open ${repoFilter} sort:updated-desc`,
  };

  const merged = new Map<string, PrSummary>();
  try {
    const data = await graphqlWithVars<{
      recent: { nodes: SearchPrNode[] };
      mine: { nodes: SearchPrNode[] };
      reviewRequested: { nodes: SearchPrNode[] };
      assigned: { nodes: SearchPrNode[] };
      all: { nodes: SearchPrNode[] };
    }>(INBOX_QUERY, {
      qMine: sections.mine,
      qReview: sections.review_requested,
      qAssigned: sections.assigned,
      qAll: sections.all,
      qRecent: sections.recent,
    });

    const bySection: Array<[InboxSection, SearchPrNode[]]> = [
      ["recent", data.recent?.nodes ?? []],
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

  const prs = [...merged.values()];
  await fillInboxEnrichment(prs, repos);

  const value: InboxCacheValue = {
    viewer,
    prs,
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
  checkSuite: { app: { name: string } | null } | null;
}
interface StatusContextEntry {
  __typename: "StatusContext";
  context: string;
  state: string | null;
  targetUrl: string | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommentNode {
  id: string;
  author: { login: string } | null;
  body: string;
  bodyHTML: string | null;
  createdAt: string;
  url: string;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  comments: { pageInfo: PageInfo; nodes: CommentNode[] };
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
  bodyHTML: string | null;
  labels: { nodes: Array<{ name: string }> } | null;
  commits: {
    totalCount: number;
    nodes: Array<{ commit: { statusCheckRollup: { state: string | null; contexts: { nodes: Array<CheckRunContext | StatusContextEntry> } } | null } }>;
  };
  files: {
    pageInfo: PageInfo;
    nodes: Array<{ path: string; additions: number; deletions: number; changeType: string; viewerViewedState: string }>;
  };
  reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] };
  /** This viewer's latest matching review only — aliased from `reviews` to avoid clashing with
   * `latestReviews` below (used for `myLastReviewSha`, not `PrDetail.reviews`). */
  myReviews: { nodes: Array<{ submittedAt: string | null; author: { login: string } | null; commit: { oid: string } | null }> };
  latestReviews: { nodes: LatestReviewNode[] };
  reviewRequests: { nodes: ReviewRequestNode[] };
}

const THREAD_FIELDS = `
  id isResolved isOutdated path line originalLine diffSide
  comments(first: 50) { pageInfo { hasNextPage endCursor } nodes { id author { login } body bodyHTML createdAt url } }
`;

/** Full PR fetch: core fields plus the first page each of files and review threads. */
function buildPrCoreQuery(owner: string, name: string, number: number, viewerLogin: string): string {
  return `
    query {
      repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) {
        pullRequest(number: ${number}) {
          id number title url state isDraft
          author { login avatarUrl }
          createdAt updatedAt additions deletions changedFiles reviewDecision
          baseRefName headRefName headRefOid baseRefOid
          body
          bodyHTML
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
                      ... on CheckRun { name conclusion status url checkSuite { app { name } } }
                      ... on StatusContext { context state targetUrl }
                    }
                  }
                }
              }
            }
          }
          files(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { path additions deletions changeType viewerViewedState }
          }
          reviewThreads(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_FIELDS} }
          }
          myReviews: reviews(last: 1, author: ${gqlString(viewerLogin)}, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
            nodes { submittedAt author { login } commit { oid } }
          }
          latestReviews(first: 100) {
            nodes { state submittedAt url author { __typename login } }
          }
          reviewRequests(first: 50) {
            nodes {
              requestedReviewer {
                __typename
                ... on User { login }
                ... on Team { name slug }
                ... on Bot { login }
                ... on Mannequin { login }
              }
            }
          }
        }
      }
    }
  `;
}

/** Lean follow-up query for additional pages of files only (no threads/commits/labels). */
function buildFilesPageQuery(owner: string, name: string, number: number, after: string): string {
  return `
    query {
      repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) {
        pullRequest(number: ${number}) {
          files(first: 100, after: ${gqlString(after)}) {
            pageInfo { hasNextPage endCursor }
            nodes { path additions deletions changeType viewerViewedState }
          }
        }
      }
    }
  `;
}

/** Lean follow-up query for additional pages of review threads only. */
function buildThreadsPageQuery(owner: string, name: string, number: number, after: string): string {
  return `
    query {
      repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) {
        pullRequest(number: ${number}) {
          reviewThreads(first: 100, after: ${gqlString(after)}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_FIELDS} }
          }
        }
      }
    }
  `;
}

/** Follow-up query for additional comment pages within one thread. */
function buildThreadCommentsPageQuery(threadId: string, after: string): string {
  return `
    query {
      node(id: ${gqlString(threadId)}) {
        ... on PullRequestReviewThread {
          comments(first: 50, after: ${gqlString(after)}) {
            pageInfo { hasNextPage endCursor }
            nodes { id author { login } body bodyHTML createdAt url }
          }
        }
      }
    }
  `;
}

const FILE_CAP = 3000;
const THREAD_CAP = 1000;
const COMMENTS_PER_THREAD_CAP = 300;

async function fetchPrDetail(repo: string, number: number): Promise<PrDetail> {
  const { owner, name } = splitRepo(repo);
  const viewer = await getViewer();

  const coreRaw = await graphql(buildPrCoreQuery(owner, name, number, viewer));
  const coreData = coreRaw as { repository: { pullRequest: PrQueryResult | null } | null };
  const basePr = coreData.repository?.pullRequest;
  if (!basePr) throw new Error(`Pull request ${repo}#${number} was not found on GitHub.`);

  // Files: continue pagination with a lean query (no threads/commits/labels re-fetched).
  const files = [...(basePr.files?.nodes ?? [])];
  let filesPageInfo = basePr.files?.pageInfo ?? { hasNextPage: false, endCursor: null };
  while (filesPageInfo.hasNextPage && filesPageInfo.endCursor && files.length < FILE_CAP) {
    const raw = await graphql(buildFilesPageQuery(owner, name, number, filesPageInfo.endCursor));
    const page = (raw as { repository: { pullRequest: { files: PrQueryResult["files"] } | null } | null }).repository
      ?.pullRequest?.files;
    files.push(...(page?.nodes ?? []));
    filesPageInfo = page?.pageInfo ?? { hasNextPage: false, endCursor: null };
  }

  // Review threads: continue pagination with a lean query (G3 — previously hard-capped at 100).
  const threadNodes = [...(basePr.reviewThreads?.nodes ?? [])];
  let threadsPageInfo = basePr.reviewThreads?.pageInfo ?? { hasNextPage: false, endCursor: null };
  while (threadsPageInfo.hasNextPage && threadsPageInfo.endCursor && threadNodes.length < THREAD_CAP) {
    const raw = await graphql(buildThreadsPageQuery(owner, name, number, threadsPageInfo.endCursor));
    const page = (raw as { repository: { pullRequest: { reviewThreads: PrQueryResult["reviewThreads"] } | null } | null })
      .repository?.pullRequest?.reviewThreads;
    threadNodes.push(...(page?.nodes ?? []));
    threadsPageInfo = page?.pageInfo ?? { hasNextPage: false, endCursor: null };
  }

  // Comments: only threads whose first 50 were already truncated pay for extra round trips.
  await Promise.all(
    threadNodes.map(async (t) => {
      let pageInfo = t.comments?.pageInfo ?? { hasNextPage: false, endCursor: null };
      while (pageInfo.hasNextPage && pageInfo.endCursor && t.comments.nodes.length < COMMENTS_PER_THREAD_CAP) {
        const raw = await graphql(buildThreadCommentsPageQuery(t.id, pageInfo.endCursor));
        const page = (raw as { node: { comments: { pageInfo: PageInfo; nodes: CommentNode[] } } | null }).node?.comments;
        if (!page) break;
        t.comments.nodes.push(...page.nodes);
        pageInfo = page.pageInfo;
      }
    }),
  );

  const threads: Thread[] = threadNodes.map((t) => ({
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
      bodyHtml: c.bodyHTML ?? "",
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
      return { name: c.name, state: mapCheckRunState(c.status, c.conclusion), url: c.url ?? null, app: c.checkSuite?.app?.name ?? null };
    }
    return { name: c.context, state: mapSearchChecks(c.state), url: c.targetUrl ?? null, app: null };
  });

  // `myReviews` (aliased `reviews`) is already filtered server-side to this viewer's latest
  // matching review (X8), so this is correct even on busy PRs where the viewer's review is far
  // from the most recent one.
  const myLastReviewSha = basePr.myReviews?.nodes?.[0]?.commit?.oid ?? null;

  const prAuthor = basePr.author?.login ?? "ghost";
  const reviews = mapLatestReviews(basePr.latestReviews?.nodes ?? [], prAuthor);
  const reviewRequests = mapReviewRequests(basePr.reviewRequests?.nodes ?? []);

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
    bodyHtml: basePr.bodyHTML ?? "",
    nodeId: basePr.id,
    baseSha: basePr.baseRefOid,
    commits: basePr.commits?.totalCount ?? 0,
    viewer,
    myLastReviewSha,
    files: mappedFiles,
    threads,
    checks,
    reviews,
    reviewRequests,
  };
}

const prCache = new BoundedCache<{ at: number; value: PrDetail }>(200);
const PR_TTL_MS = 20_000;

async function getPr(repo: string, number: number, refresh?: boolean): Promise<PrDetail> {
  const key = `${repo.toLowerCase()}#${number}`;
  if (!refresh) {
    const cached = prCache.get(key);
    if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.value;
  }
  const detail = await fetchPrDetail(repo, number);
  prCache.set(key, { at: Date.now(), value: detail });
  return detail;
}

export function invalidatePr(repo: string, number: number): void {
  prCache.delete(`${repo.toLowerCase()}#${number}`);
}

/** Node id + head sha for mutations. Shares `getPr`'s TTL/cache (X6) instead of its own
 * never-expiring cache, so a recorded "viewed" blob sha can't go stale after new commits land. */
async function getPrRef(repo: string, number: number): Promise<{ nodeId: string; headSha: string }> {
  const detail = await getPr(repo, number);
  return { nodeId: detail.nodeId, headSha: detail.summary.headSha };
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

  handle(server, prGetRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    return services.github.getPr(repo.slug, input.number, input.refresh);
  });

  handle(server, fileViewedRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    const viewedState = await services.github.setViewed(repo.slug, input.number, input.path, input.viewed);
    return { path: input.path, viewed: viewedState };
  });

  handle(server, reviewSubmitRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    const { owner, name } = splitRepo(repo.slug);
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
      // The submitted review changes threads/reviewDecision/myLastReviewSha: don't serve the
      // now-stale cached PrDetail for the rest of its TTL (X5 — client triggers re-analysis).
      invalidatePr(repo.slug, input.number);
      return { url: typeof htmlUrl === "string" ? htmlUrl : null };
    } catch (error) {
      throw new Error(`Could not submit the review: ${errorMessage(error)}`);
    }
  });

  handle(server, threadReplyRpc, async (input) => {
    const repo = await requireRepo(input.repo);
    try {
      await graphql(
        `mutation { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: ${gqlString(input.threadId)}, body: ${gqlString(input.body)} }) { clientMutationId } }`,
      );
      if (input.resolve) {
        await graphql(
          `mutation { resolveReviewThread(input: { threadId: ${gqlString(input.threadId)} }) { clientMutationId } }`,
        );
      }
      invalidatePr(repo.slug, input.number);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}

export { getLocalViewedRecords } from "./viewed-store";
