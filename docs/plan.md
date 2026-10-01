# Paseo PR Review — Plan

Status: v0.1 implemented · 2026-10-01 · targets Paseo plugin API 0.11, runs on 0.10.2 via an adapter. See §15 for known v0.1 limitations.

A Paseo plugin that makes large GitHub pull requests easy to review and easy to ship. It is
built on the Paseo plugin SDK, `gh`, local git, System One decision models (Jev / Cloudflare
Clef), and the user's Paseo agents.

## 1. Goals

1. **PR inbox** for repos already added to Paseo, with My PRs / Review requested / All open
   sections, plus filter, sort and search.
2. **PR screen** with vertical tabs:
   - Overview
   - one tab per module, with Noise last
   - Validators
   - Conversations
   - Visual
   - Chat
3. **Fast orientation in big diffs**:
   - noise collapse
   - moved-code detection
   - a reading order (foundations first by default)
   - per-file viewed state synced with GitHub
   - "changed since my last review"
4. **Validators**: user-authored mini-prompts evaluated by a System One decision model, never
   by an agent.
5. **Chat with a PR** using the user's Paseo agents.
6. **Rich HTML PR descriptions** rendered in Paseo, while degrading cleanly on github.com.
7. **Precompute** analysis for PRs that need the user's attention, so they open instantly.

Non-goals for v1:
- GitLab or Gitea.
- GitHub Enterprise.
- Hunk-level viewed state.
- Posting AI findings to GitHub automatically. A human always submits.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Paseo API | Target 0.11 (`addScreen`, `addSidebarHeaderItem`) with an adapter that falls back to 0.10 (`addSurface`, `addSidebarItem`). Manifest `requirements.paseo: ">=0.10.2"`. |
| Repo scope | Only repos registered as Paseo projects (`paseo.projects.list()`). Repo config lives in `.paseo/review.yml` and `.paseo/validators/`. |
| Decision model | System One API. Default is **OpenRouter** (`/api/v1/systemone`, `typesafe/jev-1.13`). Cloudflare Clef-flash, TypeSafe Jev and any self-hosted compatible endpoint are supported, and the endpoint URL can be overridden. Use it wherever a typed decision suffices. |
| Validators | Decision model only. No path globs or other heuristics. |
| Other analysis | Git/path heuristics are welcome; the decision model handles the judgment calls. |
| Generation (prose, chat, HTML) | Paseo agents (Claude Code / Codex / Cursor / OpenCode / user agent profiles). |
| Reading order | Foundations first is the default; riskiest first and chronological are selectable. |
| Viewed state | GitHub's Viewed checkbox is the source of truth (two-way sync), plus local enhancements (§6.6). |
| Agent tooling | One read-only toolset (an MCP server hosted by the plugin) for all providers. |
| Sidebar hygiene | No new Paseo projects. One review workspace per project. PR worktrees only on demand. Labels once the SDK allows (§9). |
| Code reuse | Bootstrap from Ironside's plugin and transplant review-deck modules (§10). |

## 3. Architecture

```
┌──────────── Paseo app (desktop / web / mobile) ─────────────┐
│ client/  React Native                                       │
│  Inbox screen · PR screen (tab rail) · diff viewer          │
│  markdown + HTML description renderer (web: sandboxed frame)│
│  settings screen · Command Center / slash commands          │
└───────────────▲─────────────────────────────────────────────┘
                │ plugin RPC (zod contracts in shared/, 30 s cap → start-then-poll jobs)
┌───────────────┴──────── plugin subprocess (daemon host) ────┐
│ server/github   gh api graphql (lists, details, threads,    │
│                 viewed state, reviews)                      │
│ server/git      mirror repos, diffs, moves, renames,        │
│                 import graph, interdiffs                    │
│ server/decide   System One client (Jev, Clef), batching,    │
│                 rate limits, cache                          │
│ server/agents   job runner over paseo.agents (start, poll,  │
│                 parse, archive)                             │
│ server/tools    read-only MCP server (HTTP, 127.0.0.1,      │
│                 bearer token)                               │
│ server/jobs     analysis pipeline + precompute scheduler    │
│ server/store    cache + review state under                  │
│                 $PASEO_HOME/plugin-data/pr-review/          │
└─────────────────────────────────────────────────────────────┘
```

Server rules:
- All GitHub, git and model calls run on the daemon host. Mobile clients get the same features
  over Paseo's relay.
- Every long operation is a job. An RPC starts it; the client polls it (or long-polls for at
  most 20 s).
- The analysis pipeline is staged, and each stage is cached independently:
  `fetch → git facts → heuristics → decisions → (optional) agent summaries`.

## 4. Data layer

### 4.1 Repos and mirrors

1. List Paseo projects.
2. Resolve each project's GitHub `owner/repo` from `git remote get-url` (handle `origin` and
   `upstream`).
3. Keep a bare mirror per repo at `$PASEO_HOME/plugin-data/pr-review/repos/<owner>__<repo>.git`.
   - Create it with `git clone --bare --reference <project root>`, so objects are borrowed and
     the clone is fast and small.
   - Fetch `+refs/pull/<n>/head:refs/pr/<n>/head` plus the base branch.
   - The user's checkout and refs are never touched.
   - The mirror is not a Paseo project, so it never appears in the sidebar.
4. Pin diff output so user git config can't break parsing (from review-deck's GitRunner):
   - `diff.noprefix=false`, `a/` and `b/` prefixes
   - `GIT_OPTIONAL_LOCKS=0`
   - `GIT_TERMINAL_PROMPT=0`

Diffs are always computed locally. GitHub's diff API returns 406 above about 300 files or 20k
lines, which is exactly the PR size we care about.

### 4.2 GitHub, via `gh api graphql` on the daemon host

| Area | What we use |
|---|---|
| Lists | `search(type: ISSUE, query: "is:pr is:open repo:… …")`, with sections for `author:@me`, `review-requested:@me` and all. |
| Details | Title, body (raw, HTML preserved), state, draft, base/head, `reviewDecision`, checks rollup, commits, `files { path additions deletions changeType viewerViewedState }`. |
| Threads | `reviewThreads { isResolved, comments, path, line, originalLine, diffSide }`. |
| My reviews | Latest review by viewer, with `commit.oid` (the anchor for "since my last review"). |
| Mutations | `markFileAsViewed`, `unmarkFileAsViewed`, add pending review + comments, submit review (approve / request changes / comment). |

### 4.3 Store

- JSON-lines or SQLite under `$PASEO_HOME/plugin-data/pr-review/`. Never the plugin install
  directory, which `paseo plugin remove` deletes.
- Every derived artifact is keyed by content (§6.10), so pushes and rebases invalidate only what
  actually changed.
- Repo slugs are validated as `owner/name` and compared case-insensitively everywhere a repo is
  looked up. Per-repo data files are named `<owner>__<name>[__<number>].json`, with the slug
  lowercased, under `$PASEO_HOME/plugin-data/pr-review/`.

## 5. Decision engine (System One)

### 5.1 API facts we design around

- **Request:** `{ model, state, questions }`. `state` is text or JSON.
- **Question types:**
  - `noul`: probability of yes.
  - `choice`: 2 to 255 options, returns a choice plus a probability distribution.
  - `score`: 2 to 10 ordered levels, returns a weighted score plus a distribution.
- **Instructions** can reference state fields as `` `field` ``.
- **Output:** typed answers only. No prose, no rationale, no line numbers.
- **Limits:**
  - at most 64 questions per request
  - about 64k tokens of shared context
  - about 32k tokens per question
- **Speed and cost:**

  | Model | Latency | Price |
  |---|---|---|
  | Jev | 70–500 ms | $0.042 per 1M input tokens; output is free |
  | Clef-flash | ~39 ms median | $0.09 per 1M tokens |
  | Clef | ~209 ms median | $0.24 per 1M tokens |

- **Rate limits (Jev):** about 1,200 requests/min. Back off on 429 and 529.
- **Weak spots (documented):** counting, dates, multi-hop or indirect questions, and large
  irrelevant state. Design implication: keep each `state` small and focused, and phrase every
  question as a direct single-property check.

### 5.2 Client

`server/decide` is a thin client that we write ourselves. The MIT `system-one` npm package is
v0.1.1 and a reference only.

Adapters:

| Adapter | Endpoint | Model | Auth / notes |
|---|---|---|---|
| OpenRouter (default) | `POST https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | Bearer key (`OPENROUTER_API_KEY`) |
| TypeSafe Jev | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest`, or pinned | Bearer key |
| Cloudflare Workers AI | `POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/cloudflare/clef[-flash]` | `clef` / `clef-flash` | Unwraps the `result` envelope |
| Cloudflare AI Gateway | Gateway URL | — | Optional; adds caching and logging |

The **Endpoint URL** setting overrides the request URL for whichever provider is selected,
including OpenRouter, so any of the above can be pointed at a self-hosted or gateway endpoint.

Other client features:
- Request batching: group questions that share a `state`, in chunks of 64.
- A bounded worker pool, retry with jitter, and per-run token accounting.
- **Credentials:** daemon-host environment variables (`TYPESAFE_API_KEY`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) are preferred. Plugin settings are the
  fallback, stored on the daemon host.
- **Privacy:** sending code to an external decision API is a per-repo opt-in, off by default,
  and the opt-in is enforced everywhere a repo's content could reach the decision API: the
  analysis pipeline, the validators "Test on this PR" action, and `/validate` on a local branch
  (which resolves the workspace to its registered repo and refuses to run if that repo isn't
  opted in). When a repo is off, everything degrades to git/path heuristics only, validators are
  unavailable for it, and inbox attention scoring is skipped for its PRs.
  What actually leaves the machine for an opted-in repo: diff hunks/file diffs and the PR title
  for validators and module/noise/risk/complexity classification; PR title, body and file stats
  for severity and change type. Inbox attention scoring sends PR metadata only (title, author,
  sections, size, checks, review decision, draft state, age) — no code — and only runs for
  repos that are opted in.

### 5.3 Where the decision engine is used

| Use | Unit (`state`) | Question |
|---|---|---|
| Validators (§7) | hunk / file / PR | `choice` {violation, compliant, not_applicable} per validator |
| Module assignment, after heuristics | file: path, language, diff excerpt, PR title | `choice` over the repo's module taxonomy |
| Noise, after git facts | file diff | `noul` "mechanical / low-signal change?" |
| Risk | file diff + path | `score` 1–5 (impact if wrong) |
| Complexity | file diff | `score` 1–5 (effort to understand) |
| PR severity | title, body, module stats, top-risk hunks | `score` 1–5 |
| PR change type | title, body, file list | `choice` {feature, fix, refactor, perf, deps, chore, docs, test} |
| "Changed since viewed" | old patch vs new patch of one file | `noul` "substantive change?" (trivial: rebase, format, comment-only) |
| Thread triage | comment, original hunk, current hunk | `choice` {addressed, partially, not_addressed, unclear} |
| Inbox attention | PR metadata, my role, CI, age, size | `score` 1–5 |
| Precompute gating | PR stats + severity | `noul` "worth an agent summary?" |

Each file gets one request that combines its module, noise, risk and complexity questions.

**Rough cost:** a 3,000-line PR with ~200 hunks, ~1.5k tokens per hunk and ~40 validators is
about 300k tokens. On Jev that's about $0.013 and a few seconds of wall time with concurrency.
Analysis is effectively free; agents remain the cost centre.

## 6. Review experience

### 6.1 Inbox (screen + sidebar item)

**Sections:**
- My PRs
- Review requested
- Mentioned / assigned
- All open

**Each row shows:**
- title, number, author, age
- draft and CI status, review decision
- +/− and effective lines
- change type and severity (from the decision engine)
- unresolved thread count
- "N files changed since your last review"

Change type, severity, attention and "changed since your review" populate once an analysis
exists for that PR; attention is scored only for repos opted into the decision API (§5.2).

**Sorting and filtering:**
- Sort by attention score (default), updated, created, size or severity.
- Filter by repo, author, label, draft, CI, review decision or base branch.
- Free-text search.

**Freshness:** poll on focus and on an interval, rendering from cache immediately.

### 6.2 PR screen

- **Tab rail:** vertical on wide layouts; on compact layouts it becomes a horizontal scroller.
- **Header:**
  - title, state, branches, CI and review decision
  - a reading-order selector
  - a "since my last review" toggle
  - review actions (approve / request changes / comment, submitting the pending review)
- **Overview tab:**
  - the description: rich HTML when present (§8), otherwise markdown
  - stats: raw vs effective lines, files, commits, threads open/resolved, checks
  - severity with the top drivers
  - a module map with risk, size and viewed progress
  - the validator scoreboard
  - an agent summary when available
- **Module tabs:** each lists files in reading order, with per-file risk and complexity chips,
  viewed checkbox, moved/renamed badges, inline threads and validator markers. Noise is last
  and collapsed into a skim view.
- **Validators tab:** results grouped by validator, with "Explain" and "Draft comment" actions.
- **Conversations tab:** unresolved threads grouped by module, with their thread-triage verdict
  (stored in `Analysis.threadTriage`, keyed by thread id).
- **Visual tab:** the generated visual overview (§8.3).
- **Chat:** opens or creates the PR chat (§8.4).

### 6.3 Modules

Each repo can override the taxonomy in `.paseo/review.yml`; the defaults are, in foundation
order:

1. Data model & migrations
2. API & contracts
3. Core logic
4. UI
5. Tests
6. Infra / config / CI
7. Docs
8. Noise

Files are assigned in three passes:

1. **Git facts and path heuristics** handle the obvious cases.
   - Noise: lockfiles, `linguist-generated` / `linguist-vendored` from `.gitattributes`,
     rename-only, whitespace-only, snapshots, minified files.
   - Tests: `*_test.*`, `*.test.*`, `__tests__/`.
   - Migrations: `migrations/`.
   - Infra: `.github/`.
   - Docs: `docs/`, `*.md`.
   - Repo rules in `.paseo/review.yml` take precedence.
2. **The decision engine** assigns the remaining files with a `choice` question. Assignments
   with confidence below 0.6 are flagged "unsure" and placed by path.
3. **The user can move a file** to another module. This is persisted per PR and used as a
   labelled example for later threshold tuning.

Assignment is per file in v1.

### 6.4 Reading order

| Mode | Order |
|---|---|
| Foundations first (default) | Modules in taxonomy order. Within a module, files in dependency order: definitions before users. |
| Riskiest first | Files by risk score (ties broken by complexity, then size). Modules by their highest-risk file. |
| Chronological | Files by the first PR commit that touched them (`git log --reverse base..head`). |

For dependency order:
- Parse per-language imports (TS/JS, Python, Go, Java/Kotlin, Rust, Ruby) with regexes and
  resolve them to PR files.
- Topologically sort the result, breaking cycles by path.
- Languages we don't parse fall back to path order.

Noise is always last. The selection persists per user.

### 6.5 Diff viewer

- **Rendering:**
  - virtualized (`FlatList` with fixed row heights)
  - unified or split view
  - `@getpaseo/highlight` syntax colouring
  - hunk-level expansion of context lines
- **Moved code:** use git's `--color-moved` semantics (parsed with pinned colour config).
  - Pure moves collapse to "moved from `path:line`".
  - Moves with edits show only the changed lines.
- **Renames:** shown as renames (`-M -C`). Whitespace-only hunks are collapsed.
- **Inline items:**
  - existing threads (read and reply)
  - draft comments (added to a pending GitHub review)
  - validator markers
- **Keyboard (desktop):**
  - `j` / `k`: next / previous file
  - `v`: mark viewed and jump to the next unviewed file in reading order
  - `n`: next unresolved item

### 6.6 Viewed state and "since my last review"

**Viewed state**
- **Sync with GitHub.** Read `viewerViewedState` (VIEWED / UNVIEWED / DISMISSED), and write with
  `markFileAsViewed` / `unmarkFileAsViewed`. GitHub sets DISMISSED when a viewed file later
  changes, which is exactly the reset behaviour we want.
- **Local enhancement.** When you mark a file viewed, we also store its blob SHA and the PR
  head. When GitHub reports DISMISSED, the file shows a "changed since you viewed" badge. Opening
  it shows only the interdiff between your viewed blob and the current blob. The decision
  engine labels that delta substantive or trivial.
- **No automatic re-marking.** We never re-mark a file viewed on the user's behalf.
  "Mark viewed & next" makes re-marking one keystroke.
- **Progress** appears per module and per PR: files viewed and effective lines viewed.

**Since my last review**
- **Anchor:** the head commit of your latest submitted review, or the last head you fully viewed
  (whichever is later).
- **Filter:** every tab can be filtered to files whose blob changed between the anchor and the
  current head.
- **Rebase-only changes** are detected per file by comparing patch IDs of `anchorBase..anchor`
  and `base..head`. Those files are hidden and listed in a "rebase-only" footnote.

### 6.7 Repo guidance files

At the PR head, collect:
- `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` from the repo root;
- the same files from the nearest ancestor of each touched directory.

They go to every agent: the system prompt for chat, summaries, explanations and descriptions.
Validators stay explicit files; Phase 3 adds an agent action that drafts validators from
`REVIEW.md`.

### 6.8 Precompute

**Scheduler:** runs in the plugin subprocess every N minutes for review-requested PRs and my
PRs in Paseo projects. It triggers on a new head SHA.

**Stages:**

| Stage | Contents | When it runs |
|---|---|---|
| Fetch + git facts + heuristics | — | Always |
| Decision engine | modules, risk, severity, validators, thread triage | Always, if the repo opted in |
| Agent summaries | — | Only when the gating question says yes and the daily budget allows |

**Guardrails:**
- Skip drafts (configurable).
- One or two jobs at a time.
- A per-day agent budget.
- A size cap.
- A separate agent profile for precompute, e.g. a cheap model.

**Gotcha:** a server contribution only gets the `paseo` API inside handlers and hooks. The
scheduler captures it from the first RPC or lifecycle event. Until then it runs only stages that
don't need agents.

## 7. Validators

### 7.1 Format

One markdown file per validator.

**Locations:**
- the repo's `.paseo/validators/*.md`, shared and reviewed like code;
- the user's personal library under `$PASEO_HOME/plugin-data/pr-review/validators/`, which
  applies to every repo.

They can be enabled per repo. The format is compatible with awesome-reviewers, so its rules can
be imported directly.

```md
---
title: Authorization is enforced on endpoints
severity: blocking          # blocking | warning | info
unit: hunk                  # hunk (default) | file | pr
threshold: 0.8              # P(violation) needed to report a failure
violation: A new or changed endpoint/handler performs reads or writes without an authorization check
compliant: The endpoint checks the caller's permission before acting, or delegates to middleware that does
not_applicable: The change does not add or modify a request handler
---
Does this change let a caller act on data without an authorization check?
```

### 7.2 Evaluation

| Unit | `state` contents |
|---|---|
| `hunk` (default) | `{pr_title, path, language, hunk, context}`, where `context` is the enclosing function, or ±40 lines when it can't be found |
| `file` | `{pr_title, path, file_after, file_diff}`, truncated with a notice above 32k tokens |
| `pr` | `{title, body, files_with_stats}` |

1. Each validator becomes one `choice` question. Its `instructions` are the body; its criteria
   are the `violation`, `compliant` and `not_applicable` fields.
2. All enabled validators for a unit go into the same request, in chunks of 64. Different units
   run in parallel.
3. Results per unit and validator, with p = P(violation):
   - **fail** when p ≥ threshold
   - **uncertain** when 0.5 ≤ p < threshold (shown muted)
   - **n/a** when `not_applicable` wins
   - **pass** otherwise
4. A validator fails if any unit fails.
5. Locations are the unit's file and line range, so hunk granularity is the precision.
6. **Cache key:** `sha(validator file) + sha(unit state) + model`. After a push, only changed
   hunks are re-evaluated.

### 7.3 Surfacing

- **Scoreboard** in Overview, e.g. "✓ 31 · ✗ 2 · ? 1 · — 9 n/a".
- **Markers** in the diff.
- **Validators tab** with each failure's calibrated probability.
- **Explain:** an on-demand read-only agent that gets the validator, the unit and the toolset,
  and returns an explanation and a suggested fix. This is the only place agents touch
  validators; they never produce verdicts.
- **Draft comment:** adds the finding to the pending GitHub review.
- **Dismiss:** records a false positive (validator, unit hash) and offers "add as a counter
  example", which appends to the validator's `compliant` text.

### 7.4 Authoring support

- **Test validator:** runs a draft validator against the open PR as a background job
  (`prr.validators.test` starts it, `prr.job.poll` returns the result) and shows p per unit in
  about a second.
- **Guide:** single-property questions, explicit `violation` / `compliant` / `not_applicable`
  text, nothing multi-hop or counting-based (Jev's documented weak spots).
- **Starter pack:** about 15 validators adapted from awesome-reviewers (Apache-2.0), plus a
  browser to import more from its 1,000 rules.

### 7.5 Running on your own branch

The same engine runs against any Paseo workspace diff (`base...HEAD`). It is reachable from a
workspace panel, a `/validate` slash command and a Command Center item, so problems are caught
before the PR is opened.

## 8. Agents: generation only

### 8.1 Runner

Built on `paseo.agents` (pattern adapted from review-deck). Every task that creates an agent,
including chat start, runs as a background job (`prr.job.poll`), per the start-then-poll rule
in §3:

1. Create the agent with labels `pr-review.kind` and `pr-review.pr`.
2. Poll `waitForFinish(2000)` from short RPCs.
3. Handle output:
   - **Codex, OpenCode:** use `outputSchema`.
   - **Claude, Cursor:** ask for JSON in the prompt, then extract, validate with zod, and retry
     once.
4. Archive the agent in `finally`.

**Agent choice:** available providers plus the user's agent profiles from `paseo.config.get()`.
Each task (summary, chat, explain, describe, visual) has its own default.

### 8.2 Read-only toolset

The plugin subprocess hosts a single long-lived HTTP MCP server (not one per task) bound to
`127.0.0.1:<random>`, issuing a fresh bearer token per session/task. It reads from the mirror
at exact commits.

**Tools:**
- `pr_overview`
- `list_files(module?)`
- `get_diff(path | module)`
- `read_file(path, ref = head | base)`
- `search(pattern, ref)`
- `list_threads`
- `list_findings`
- `repo_guidance`

**Approval:** the tools are pre-approved via `toolPolicy`. Paseo's source honours this for
Claude, Codex and OpenCode. Cursor (ACP) doesn't, so Phase 0 includes a spike to confirm
permission behaviour or fall back to its Ask mode.

### 8.3 Agent tasks

| Task | Where | Output |
|---|---|---|
| Overview summary + per-module summaries | review workspace | JSON → Overview / module tabs (cached by head) |
| Explain finding / thread | review workspace | Explanation + suggested fix |
| Visual overview | review workspace | Self-contained HTML (§9.3), cached by head |
| Describe PR (my branches) | the user's workspace | Markdown + `paseo:html` block |
| Chat | PR worktree workspace | Native Paseo chat |

### 8.4 Chat with a PR

1. Create, or reuse, the PR's worktree workspace with Paseo's native checkout:
   `workspaces.create({ source: { kind: "worktree", action: "checkout", checkoutSource: { kind: "change_request", forge: "github", number } } })`.
2. Start the agent in a read-only mode. The system prompt contains the PR context pack: title,
   body, module map, summaries, findings, unresolved threads and guidance files. The agent also
   gets the toolset.
3. Open it with `navigation.openAgent`. This gives native streaming, tool calls, permissions,
   Mermaid and mobile.
4. From any module tab or finding, "Ask about this" seeds the chat with that context.

## 9. Workspaces, sidebar and HTML

### 9.1 Sidebar hygiene

- Mirrors are not Paseo projects.
- Each project gets one "PR Review" worktree workspace, created on first use, which hosts
  analysis agents. Those agents are archived after every job.
- PR worktree workspaces are created only for Chat.
  - They're titled `PR #123 · <title>` and reused per PR.
  - They're auto-archived when the PR merges or closes, or after N idle days.
- **Labels: not possible from a plugin today.**
  - Paseo's protocol has `workspace.label.assignment.set`, but the plugin SDK (`PaseoApi`) does
    not expose it, and the CLI has no label command.
  - The sidebar label filter is include-only, though it has an "Unlabelled" option.
  - Plan: an upstream PR to expose label assignment in the SDK, with an "exclude label" filter
    as a nice-to-have.
  - Until then: title prefixes plus auto-archive. Users can label manually.

### 9.2 Rich HTML descriptions

**Convention:**
- The PR body is normal markdown, so github.com stays readable.
- It may also contain one hidden block: `<!-- paseo:html -->…<!-- /paseo:html -->`.
- GitHub stores the raw body, so the block survives, but github.com doesn't display it.
- The body is limited to 65,536 characters in total.

**Rendering on desktop and web:**
- A sandboxed iframe from `client/web.ts`, gated by `Platform.OS === "web"`.
- It uses Paseo's own HTML-preview CSP (Apache-2.0): `sandbox="allow-scripts"`, opaque origin,
  inline scripts and styles allowed, and network, forms and frames blocked.

**Mobile:** falls back to the markdown, with a "rich view available on desktop" note. The
upstream fix is to expose Paseo's existing HTML preview, which already has a hardened WebView,
as a plugin host component.

**Size budget:** library injection (Mermaid, a chart library) is not implemented. Each
`paseo:html` block must be fully self-contained (inline SVG/CSS/JS only) — the sandbox blocks
network access, so an externally-hosted library wouldn't load anyway. A Mermaid code fence in
the normal markdown part of the body is unaffected and still renders natively on github.com and
in the markdown fallback.

**Threat model:** PR descriptions are attacker-controlled. The sandbox is mandatory. The one
remaining hole, a page navigating itself, matches Paseo's documented one.

### 9.3 Visual overview

Generated on demand by an agent using the toolset: architecture or data-flow diagrams, a module
map, and before/after views where relevant. The agent is instructed to produce one self-contained
HTML document (inline CSS/SVG/JS only, no external libraries or network requests — see §9.2). It
uses the same renderer and is cached by head SHA.

## 10. Reuse map

| Source | License | Take | Work needed |
|---|---|---|---|
| [Ironside pull-requests](https://github.com/Ironside-Software/pull-requests-paseo-plugin) | MIT | `gh` layer, PR details, comment / approve / request-changes actions, `marked` → RN markdown, highlighted diff rows, PR-worktree launcher, header button | Port to 0.11. The diff currently renders 400-line chunks in a ScrollView; rebuild it virtualized. |
| [review-deck](https://github.com/mentalfl0w/review-deck) | MIT | Agent job runner (child agents, poll, JSON extraction, archive), cache store patterns, AnchorEngine (re-anchoring state across force-pushes), GitRunner, provider/model settings UI | Decouple from its local-diff queue model. |
| [Paseo](https://github.com/getpaseo/paseo) | Apache-2.0 | HTML-preview CSP policy (`html-preview-csp.ts`) and sandbox attributes | Keep the NOTICE / attribution. |
| [awesome-reviewers](https://github.com/baz-scm/awesome-reviewers) | Apache-2.0 | Validator starter pack and importable library | Map frontmatter to our fields. |
| [PR-Agent](https://github.com/qodo-ai/pr-agent) | MIT | Prompt text for describe and summaries | Adapt to our JSON contracts. |
| [system-one](https://github.com/lukeramsden/system-one) | MIT | Reference for System One request types and adapters | Our own client; reference only. |

Bootstrapping steps:
1. Import Ironside's code into this repo, preserving its license notice in `THIRD_PARTY.md`.
2. Restructure it to the layout below.
3. Transplant the review-deck modules.

## 11. Layout

```
paseo-plugin.json        id: pr-review, requirements.paseo >=0.11.0,
                         build: [["npm","ci","--omit=dev","--ignore-scripts"]]
                         (zod and the Paseo SDK are supplied by the daemon at runtime, so the
                         git-install build step only needs `dependencies`, not devDependencies)
index.client.tsx         registrations only
index.server.ts          registrations only
client/
  inbox/                 screen, rows, filters
  pr/                    screen, tab rail, overview, modules, validators, conversations, visual
  diff/                  virtualized viewer, moved/renamed rendering, inline items
  render/                markdown.tsx, html.tsx, web.ts (sandboxed iframe)
  settings/
server/
  github/                graphql queries/mutations via gh
  git/                   mirror, diff, moves, imports, interdiff, patch-id
  decide/                system-one client, adapters, batching, cache
  agents/                runner, prompts, parsers
  tools/                 MCP server
  jobs/                  pipeline, precompute scheduler
  validators/            loader, frontmatter, starter pack
  store/
shared/                  zod RPC contracts, settings schema, plain types
tests/
```

## 12. Phases

### Phase 0: spikes and scaffold

Scaffold:
- Bootstrap from Ironside and port it to 0.11.
- Set up a dev loop against an isolated daemon (`--home /tmp/paseo-dev`).

Spikes, each with a written result:
1. Mirror plus PR fetch on a large OSS PR (more than 300 files).
2. Jev and Clef calls. Measure latency and token counts on real hunks.
3. The MCP toolset with Claude, Codex and Cursor (pre-approval and permission behaviour).
4. The sandboxed iframe in the Electron app.
5. GitHub viewed-state round trip.

### Phase 1: review core

- The inbox.
- The PR screen with its tab rail and Overview (no agent summary yet).
- Modules from heuristics plus the decision engine.
- All three reading orders.
- The virtualized diff with moved/renamed code and noise collapse.
- Viewed-state sync, "changed since viewed" and "since my last review".
- Conversations, with thread triage.
- Review submit.
- HTML description rendering (desktop and web).
- Basic chat (PR worktree, read-only agent, context pack).

**Done when** a 300-file PR opens in under 3 s from cache, and modules, order, viewed sync and
"since last review" work on desktop and mobile.

### Phase 2: validators and precompute

- The validator format, loader, evaluation, scoreboard and markers.
- Explain, Draft comment and Dismiss.
- Test-validator.
- The starter pack.
- `/validate` on your own branch.
- The precompute scheduler with budgets.

**Done when** 40 validators on a 3k-line PR finish in under 10 s, and re-runs after a push only
evaluate changed hunks.

### Phase 3: agent features

- The toolset.
- Overview and module summaries.
- The visual overview.
- Describe PR.
- "Ask about this" from tabs.
- Drafting validators from `REVIEW.md`.

### Upstream (in parallel)

Paseo PRs to:
1. Expose workspace label assignment in the plugin SDK.
2. Expose an HTML preview host component.
3. (Optional) Add an exclude-label sidebar filter and a plugin data-directory API.

## 13. Testing

**Unit tests (vitest):**
- diff and move parsing
- heuristics
- import graphs and topological sort
- patch-id rebase detection
- cache keys
- validator frontmatter
- decision-client batching (recorded fixtures)

**Integration tests:**
- RPC handlers against fixture repos.
- `gh` calls behind an interface with recorded responses.

**Validator evaluation harness:**
- A labelled set of hunks per starter validator.
- Report precision and recall per threshold, then pick defaults.
- Re-run it whenever the model version changes.

**Manual QA:** desktop, web and phone, against an isolated daemon, using a few real large PRs.

## 14. Risks and open questions

| Risk | Detail |
|---|---|
| Decision models are new | Jev launched 2026-09-15, Clef on 2026-10-01. Their quality on code is unproven; the evaluation harness and per-validator thresholds are the mitigation. |
| Code leaves the machine | Sent to the decision API, so this is a per-repo opt-in. Agents already send code to the user's chosen providers. |
| Context limits | 32k tokens per question means very large files fall back to hunk units. |
| Paseo 0.11 is beta | Plugin API churn is likely; pin the SDK and keep the requirement range tight. |
| SDK gaps | No workspace labels, no HTML host component, no data-directory API, and no host diff view or `openFile`. Tracked as upstream PRs. |
| Cursor | ACP doesn't honour `toolPolicy` pre-approval. |
| Enterprise | GitHub Enterprise hosts are out of scope for v1. The `gh` hostname plumbing is kept so they can be added later. |

## 15. Known limitations (v0.1)

- **No library injection** in rich HTML or visual-overview blocks (§9.2, §9.3): Mermaid and
  chart libraries are not injected; `paseo:html` blocks must be self-contained. A Mermaid code
  fence in the normal markdown body is unaffected and still renders on github.com.
- **Diff viewer is unified-view only** (§6.5); split view is not implemented.
- **Desktop keyboard shortcuts** (`j`/`k`/`v`/`n`, §6.5) are not implemented yet.
- **Mobile HTML rendering** still falls back to markdown, pending the upstream HTML-preview host
  component (§9.1, §14).
- **Workspace labels** are not implemented, pending the upstream SDK change (§9.1, §14).
- **Cursor's read-only mode is best-effort**: ACP doesn't honour `toolPolicy` pre-approval
  (§8.2, §14).
- **Precompute runs PRs sequentially**, one at a time, not in parallel (§6.8).
