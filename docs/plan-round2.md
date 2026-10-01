# PR Review — Round 2 plan

Builds on `docs/plan.md`. Six workstreams, all deterministic client/server work (no Paseo agent
involvement, per the project's design rule: decision models for judgments, agents only for
prose/HTML generation).

| # | Workstream | Owner files |
|---|---|---|
| A | Outline diff (declaration-level) — server | `server/analysis/outline.ts`, `tests/analysis.outline.test.ts` |
| B | Structural diff (lockfiles, JSON, YAML) — server | `server/analysis/structural.ts`, `tests/analysis.structural.test.ts` |
| C | Outline + structural — client | `client/diff/OutlineView.tsx`, `client/diff/StructuralDiffView.tsx`, `client/review/ModuleTab.tsx`, `client/app/OverviewTab.tsx` |
| D | Side-by-side diff + bigger comment text in the diff | `client/diff/FileDiffView.tsx`, `client/diff/pairing.ts`, `tests/diff.pairing.test.ts` |
| E | PR screen shell: right status panel, diff-layout toggle, settings | `client/app/PrScreen.tsx`, `client/review/StatusPanel.tsx`, `client/settings/SettingsScreen.tsx`, `server/github/index.ts` |
| F | Inbox spacing + bigger comment text in Conversations | `client/app/Inbox.tsx`, `client/review/ConversationsTab.tsx` |

Shared contracts (types, settings, RPC, service interface, pipeline hooks, prop plumbing) were
landed first so the six streams can run in parallel without touching the same files.

## Decisions

Carried over from the visual-exploration discussion; the recommended option was taken in each
case and is easy to revisit:

1. **Extractor:** regex per language behind a small interface (`computeOutlines(files, readFile)`),
   so tree-sitter can replace an extractor per language later.
2. **Placement:** outline under each file header inside module tabs, plus an "exported surface
   changed" list on the Overview tab. No separate Outline tab.
3. **Structural v1 scope:** lockfiles and JSON/YAML. Declarative schemas (GraphQL, protobuf,
   Prisma, zod/TS interfaces) and SQL migrations are a second step.
4. **Default view:** Structure by default for lockfiles and for JSON/YAML files with more than
   150 changed lines; Text everywhere else. Per-file toggle.

New in this round:

5. **Diff layout** is a setting (`diffLayout: inline | split`, default inline) and a per-session
   toggle in the PR screen header. Split falls back to inline on compact layouts.
6. **Right status panel** on wide layouts (≈280 px, collapsible) showing review status (humans and
   bots, from GitHub's `latestReviews` plus outstanding `reviewRequests`), CI checks grouped by
   app, and the validator scoreboard with failing/uncertain validators. On compact layouts the
   same content is reachable from a "Status" button in the header.
7. **Comment text** in review threads goes from 12 px to 14 px body / 12 px author, matching the
   Markdown body size. Comment bodies in the Conversations tab render as markdown.
8. **Inbox rows** get more vertical padding and gap, and a touch more spacing between sections.

## A. Outline diff — server

`computeOutlines(files: ParsedFile[], readFile)` in `server/analysis/outline.ts`, called from the
pipeline right after the diff stage. Per file: skip binary, unsupported language, or either side
over 200 KB. Read base (at the old path for renames) and head, extract declarations from both,
then categorise.

Extraction per language (TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, Ruby): regexes
for top-level and class-member declarations, nesting via indentation (Python, Ruby) or brace
matching (the rest), qualified names (`Class.method`), `exported` by convention (`export`,
`pub`, uppercase in Go, no leading `_` in Python, non-private in Java/Kotlin). Body hash =
whitespace-normalised body excluding the signature line.

Categorisation, matching old and new by qualified name within a file:

- both sides, signature differs → `signature` (with `oldSignature`)
- both sides, body hash differs → `modified`
- new only: a removed declaration anywhere in the PR with the same body hash → `renamed`
  (same file, name differs) or `moved` (different file; reported in both files with
  `counterpart`); otherwise `added`
- old only, unmatched → `removed`
- unchanged declarations are omitted

`changedLines` counts add/del lines of the file's hunks that fall inside the declaration's range
(new-side range for added/modified/signature, old-side for removed).

Stored on `AnalyzedFile.outline` (null when skipped). `ANALYSIS_VERSION` bumped to 2 so older
cached analyses are re-run on open.

## B. Structural diff — server

`computeStructuralDiff(path, kind, oldText, newText)` in `server/analysis/structural.ts`, run
lazily by `prr.file.structural`. Eligibility is name-based (`structuralKindFor`) and stored on
`AnalyzedFile.structuralKind` so the client knows which files get a toggle without a round trip.

- **JSON / YAML:** parse both sides with the `yaml` package (`parseDocument` + `LineCounter` so
  every entry carries old/new line numbers; JSON parses as YAML, with a `JSON.parse` fallback
  without line numbers if that fails). Walk both trees; emit `added` / `removed` / `changed`
  entries with dotted paths and `[i]` indexes. Scalars render inline (strings quoted, long
  values truncated); containers summarise as `{n keys}` / `[n items]`. Array diffs are
  positional. Cap at 2,000 entries (`truncated: true`).
- **Lockfiles:** per-format parsers returning `name → version(s)`: npm `package-lock.json`
  (v1 `dependencies` and v2/v3 `packages`), `pnpm-lock.yaml`, `yarn.lock` (v1 text and berry
  YAML), `Cargo.lock`, `poetry.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`,
  `Pipfile.lock`. Entries: package name as `path`, versions as values, `changed` for bumps.
  Multiple versions of one package collapse into a sorted comma-separated list.
- Parse failure on either side → `entries: []`, `error` set; the client falls back to text.

## C. Outline + structural — client

- `OutlineView`: a collapsible list under each file header in module tabs (only when the file
  has a non-empty outline). Each row: change badge, kind, name, signature (old → new for
  signature changes), changed-line count, counterpart for moved/renamed. Tapping a row expands
  the file's diff and scrolls to the first hunk overlapping the entry's new range (old range for
  removed). A compact summary ("2 added · 1 signature") shows on the header when collapsed.
- Text / Structure toggle on the file header for files with `structuralKind`; default per
  decision 4. `StructuralDiffView` fetches `prr.file.structural` (react-query, keyed by head SHA)
  and renders rows: path, old value, new value, with colours by change kind, a filter box, and
  a "Show text diff" fallback when `error` is set.
- Overview: an "Exported surface changed" section listing `exported` entries whose change is
  `signature`, `removed` or `renamed`, grouped by file, each opening the file's module tab.

## D. Side-by-side diff

`FileDiffView` gains a `diffLayout` prop. In split mode, rows become pairs computed by a pure
`pairHunkLines(hunk)` helper (`client/diff/pairing.ts`, unit-tested): consecutive del/add runs
pair positionally, leftovers pair with an empty cell, context pairs with itself. Threads attach
below the pair containing their target line on the matching side; validator findings by new
line. Clicking an old-side gutter opens the composer for `LEFT`, new-side for `RIGHT`. Syntax
tokens are already per line index, so highlighting is unchanged. Compact layouts always render
inline.

## E. Shell

- GitHub fetch adds `latestReviews(first: 100)` (author `__typename` distinguishes bots),
  `reviewRequests(first: 50)` (users, teams, bots) and `checkSuite { app { name } }` on check
  runs, mapped onto `PrDetail.reviews`, `reviewRequests` and `checks[].app`.
- `StatusPanel` (right column) sections: Review (decision chip, reviewers with state and
  relative time, pending requests), Checks (failing first, grouped by app, tap opens URL),
  Validators (scoreboard, failing/uncertain list → Validators tab, "decision model off" note).
- Header gets an Inline / Split toggle next to reading order; Settings gets a "Diff layout"
  select.

## F. Inbox and conversations

Inbox PR rows: padding 12→14, inner gap 4→6, list gap 6→10, section headers more breathing
room. Conversations: author 11→12, body 12→14 rendered as markdown.

## Round 2b: review experience follow-ups

Added after the first batch, same deterministic rules.

| # | Workstream | Owner files |
|---|---|---|
| G | Markdown/HTML renderer rewrite | `client/render/Markdown.tsx`, `client/render/html-subset.ts`, `client/render/markdown-text.ts` |
| H | GitHub-rendered HTML view | `client/render/GithubHtmlView.tsx`, `client/render/github-css.ts`, `client/render/html-web.tsx` |
| I | Persisted UI state and recents | `shared/ui-state.ts`, `server/ui-state/`, `client/app/ui-state.ts`, `client/app/App.tsx` |
| J | Side-panel chat | `client/review/ChatPanel.tsx`, `client/review/chat-timeline.ts` |
| K | Review comments | `client/diff/FileDiffView.tsx`, `client/review/drafts.ts`, `client/review/ReviewSubmitButton.tsx`, `server/github/comments.ts` |

### Description and comment rendering
- `PrDetail.bodyHtml` and `ThreadComment.bodyHtml` carry GitHub's rendered HTML (`bodyHTML`).
  On web the Overview shows the description through `GithubHtmlView`: a sandboxed iframe
  (`allow-scripts` only, CSP with `img-src https:` and nothing else) with a GitHub-like
  stylesheet built from the theme colours, auto-sized through a height message and with link
  clicks forwarded to the external opener. Native falls back to the markdown renderer.
- The markdown renderer (`Markdown`) handles GitHub's sanitised HTML subset natively so bot
  comments (Cursor Bugbot, Copilot, CodeRabbit) read well everywhere: HTML comments are
  stripped, `<details>` becomes a collapsible, `<picture>`/`<img>`/image links render as sized
  images, `<sup>`/`<kbd>`/`<b>`/… map to inline styles, entities are decoded, GitHub alerts,
  task lists, content-sized tables, intrinsic-size images, and `@mention` / `#123` links.

### Remembering state
- `prr.ui.get` / `prr.ui.set` persist `{ lastLocation, recentPrs }` under the plugin data dir.
  The client store hydrates once per session and persists debounced; `App` restores the last PR
  and `PrScreen` restores the last tab. Recents (max 20) record every PR opened here, with
  `reviewedAt` set on review submit.
- Inbox section "Recently reviewed", first: local recents (full cards when a search returned
  the PR, title-only cards otherwise) merged with GitHub's `reviewed-by:@me` search (any state,
  so merged PRs you reviewed stay listed).

### Review comments
- Every code line has a "+" gutter (hover-lit on web, always visible on compact); drafts render
  inline under their line with Edit/Delete; the composer offers "Add to review" (pending
  review, submitted with the Review button) or "Comment now" (`prr.comment.create`, a single
  review comment on the head commit). Own comments get Edit/Delete (`prr.comment.update` /
  `prr.comment.delete`, delete needs a confirming second tap); threads get an inline Reply.
- The submit modal lets drafts be edited in place; "Comment" is disabled with nothing to send.

### Chat
- "Chat" opens a panel on the PR screen instead of navigating to the agent view. The panel
  starts or reuses the PR's agent (same worktree workspace and read-only MCP tools as before),
  subscribes to its timeline through the client daemon API (`usePaseo().agents.ref(id)`), and
  sends messages in place; "Open in Paseo" is still available.

### Whitespace
- Code lines keep whitespace (`white-space: pre` on web), tabs expand to 4 columns before
  highlighting, and whitespace-only lines show `·` / `→` markers so the change is visible.

## Verification

Each stream: `npm run typecheck`, `npx vitest run`, `npm run check:bundle`. Server streams add
unit tests with fixture files. Client changes are reviewed by reading since the client isn't
unit-tested; the final integration pass runs all three checks on the merged branch.

## Later

- Declarative schemas and SQL migrations as structural kinds.
- tree-sitter extractors behind the outline interface.
- Declarations as a validator unit.
- Bot issue comments (not reviews) in the status panel.
- Scroll-to-declaration from an outline row (needs a scroll API on the diff viewer).
- Multi-line declaration headers: the signature is the first header line only, so a parameter
  change on a later line reports as "modified" rather than "signature".
