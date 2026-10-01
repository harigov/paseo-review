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

## Verification

Each stream: `npm run typecheck`, `npx vitest run`, `npm run check:bundle`. Server streams add
unit tests with fixture files. Client changes are reviewed by reading since the client isn't
unit-tested; the final integration pass runs all three checks on the merged branch.

## Later

- Declarative schemas and SQL migrations as structural kinds.
- tree-sitter extractors behind the outline interface.
- Declarations as a validator unit.
- Bot issue comments (not reviews) in the status panel.
