# PR Review — Round 4: levels of detail, file navigation, calmer chat, cached inbox, better overview

Builds on `docs/plan-round3.md`. Five requests from Hari (2026-10-02). Status: **agreed 2026-10-02**
(decisions at the end); contracts landed, workstreams A–F in progress.

## 1. Inbox: show the last list instantly, refresh in the background

**Today.** The surface remounts on every "PR Review" click. `useInbox` has `staleTime: 0`, so every
mount refetches. Once react-query drops its copy (5 min) or the server's 30 s `inboxCache` expires,
the inbox waits on a blocking GraphQL call (five searches of up to 50 PRs, each with 100 review
threads) plus per-PR enrichment, and shows a skeleton while it waits.

**Change: stale-while-revalidate at both ends.**

- Server (`listInbox`): if any snapshot exists, return it straight away. If it is older than 60 s,
  start one background refresh (in-flight promise shared, so calls coalesce). `refresh: true` still
  waits for fresh data. Write each successful fetch to `dataDir()/inbox-cache.json` and load it on
  the first call after a daemon restart, so the first open after a restart is instant too. The
  10-minute precompute loop keeps the cache warm as it already calls `listInbox()`.
- RPC: `prr.inbox.list` adds `refreshing: boolean` (a background refresh is in flight).
- Client: a module-level copy of the last inbox (survives remounts like `ui-state.ts`) seeds
  `initialData`. `staleTime: 60 s`, `gcTime: Infinity`. While `refreshing` is true, refetch every
  3 s (bounded) until fresh data lands. The skeleton only shows on the very first load. The header
  shows "Updated 3 min ago", plus a small spinner while refreshing. The refresh button still forces
  a full fetch.

Instant PR open (agreed): opening a PR from the inbox passes its `PrSummary`, used as placeholder
data so the PR header (title, refs, state) renders immediately while the detail loads.

## 2. Levels of detail: Modules → Files → Declarations → Code

The aim is to stop showing everything at once. You pick how deep to read each module, and later a
decision model picks it for you.

| Level | Where | What you see |
|---|---|---|
| **Modules** | Overview "Change map" (replaces the Modules card) and the module rail | One row per module: new / changed / removed (from its files' statuses), files added / modified / deleted, effective lines, risk, viewed progress, and that module's level selector |
| **Files** | Module tab | One row per file: status, path, ±, declaration summary ("2 added · 1 signature"), viewed. No content |
| **Declarations** | Module tab | File header, then one row per changed declaration (kind, name, change, ±, signature change). No code. Structural files (JSON/YAML/lockfiles) show their key table here, which is their equivalent of declarations. Files with no outline (unsupported language) show one line, "No declaration outline · 14 changed lines · Show code" |
| **Code** | Module tab | Today's stream. The outline list is hidden because the header already carries the summary. A per-file "Outline" toggle brings it back |

- **Module level.** A segmented control in the module header: `Files | Declarations | Code`.
  Keyboard `1` / `2` / `3`.
- **Per-file override.** Each file header gets the same three-way control. `e` toggles the current
  file between collapsed and the module's level.
- **Drill-down without switching level.** At Declarations level, pressing a declaration expands
  only the hunks that overlap its line range, inline under that row. You can read one function's
  diff without opening the whole file.
- **Default level (deterministic, for now):** noise module → Files. Max risk ≥ 4 → Code. More than
  600 effective lines with outlines on most files → Declarations. Otherwise Code. The rule lives in
  `shared/levels.ts` (`defaultModuleLevel`).
- **Decision-model rules (agreed, built this round).** Settings → Review depth holds an ordered
  list of rules, each a plain-language condition plus a level, for example "Touches
  authentication, payments, or data migrations → Code" or "Only tests or fixtures → Files". For
  repos opted in to the decision model, each module is asked one Jev/Clef `noul` question per
  enabled rule. The state is the module's title, description, PR title, stats, file list and
  changed declarations.
  - A rule matches at P ≥ 0.7. Among matching rules the deepest level wins, ties going to the
    earlier rule.
  - The result lands on `Module.recommendedLevel`, with the rule text in `Module.levelReason`
    (shown as "Recommended: Code · Touches authentication").
  - No rules, no match, or the repo not opted in all fall back to the deterministic default
    above.
  - It runs as a pipeline stage. `Analysis.depthRulesHash` records which rules produced it. When
    the rules change, the PR screen notices the hash mismatch and runs `prr.depth.recompute`, a
    small job that re-asks only the depth questions (cached) and patches the stored analysis.
  - Settings offers "Add starter rules" to fill in a few examples.
  - The UI uses `user choice ?? recommendedLevel ?? defaultModuleLevel` and marks the recommended
    option.
- **Persistence.** Chosen levels live in a module-level store keyed by `repo#number:moduleId`, so
  they survive remounts for the app session. They are not written to disk.
- **Row model.** In `rows.ts`, `StreamFileInput.expanded` becomes `level: "collapsed" | "outline" |
  "code"`. The single `outline` row becomes one `decl` row per entry, which virtualizes and works
  with the line cursor. A new `declHunks` expansion state per file covers the inline drill-down.
  Keyboard, minimap and focus code keep working off `fileHeader` rows.

## 3. File panel and file boundaries in the module stream

**File panel** (`client/review/FilePanel.tsx`, new): a 240 px column between the module rail and
the stream.

- The module's visible files in reading order, matching the stream and the minimap. Each row shows
  a status letter (A / M / D / R, coloured), the basename with its directory muted, ±, a risk dot,
  a badge for threads, drafts and findings, and a check when viewed (viewed rows dimmed).
- The file currently in view is highlighted, using the `currentPath` the stream already tracks.
- Pressing a row scrolls to that file. A collapsed file opens at the module's level, or at
  Declarations when the module is at Files.
- A filter box appears when the module has more than 20 files.
- The panel collapses from a toggle in the module header, and that choice is remembered for the
  session. On compact layouts it becomes a "Files" button that opens the same list in a modal.

**File boundaries in the stream:**

- A 3 px rail on the left edge of every row of a file. Adjacent files alternate between accent and
  a neutral tone, so a boundary is always visible. Risk stays on the dot and the minimap; it is not
  repeated here, because a green or red rail would read as added or deleted lines.
- The sticky file header gets a 2 px top edge in the file's rail colour.
- A new `fileEnd` row after each opened file reads "End of `path` · +12 −4", followed by "Viewed &
  next" (the natural place to act once you finish a file) and then a `space.lg` gap before the next
  header.

## 4. Chat: attach context, don't send it

**Today.** A brand-new chat agent is created with the prompt "Give me a 5-bullet orientation to
this PR…", so it starts working for minutes. "Ask about this module" then also auto-sends the
module and its file list once the agent goes idle.

**Change:**

- `startChat` creates the agent with no prompt (`prompt` is optional in `agents.create`). The agent
  sits idle with the system prompt and context pack until you ask something.
- `openChat({ context })` replaces `openChat(seed)`. "Ask about this module" opens the panel,
  attaches a removable chip ("Module: Analysis · 12 files") above the composer and focuses the
  input. Nothing is sent.
- On Send, the message is your text followed by the attached context block (module title and file
  list), and the chip clears. The same mechanism can attach a file or a declaration later.
- The empty chat shows a few starter suggestions you can press to fill in, such as "Orient me in
  this PR" or "What's risky here?". None of them auto-send.

## 5. Overview: readable width, mermaid, images, SVG and video

- **Width.** The whole Overview tab (description, stats, change map, summary) sits in one centred
  column, `maxWidth: 880`, `width: 100%`. That is roughly GitHub's conversation column.
- **Mermaid:**
  - *GitHub description iframe (desktop and web).* GitHub's `bodyHTML` marks diagrams as
    `section[data-type="mermaid"]` with the source in `pre[lang="mermaid"]` / `data-plain`. When a
    body contains one, the mermaid runtime is injected into the sandboxed iframe and each diagram
    is rendered with a light or dark theme to match Paseo (`securityLevel: "strict"`). If a diagram
    fails to render, its source shows as a code block with the error.
  - *Native markdown renderer.* `Markdown.tsx` (agent summary, chat, comments, and the description
    on non-web hosts) gets a `MermaidView` for ```` ```mermaid ```` fences. On web it is a small
    sandboxed iframe using the same runtime; on native it falls back to a labelled code block.
  - *Agent rich HTML (`HtmlView`).* Gets the runtime whenever it contains `.mermaid` blocks.
  - *Delivery.* The runtime is about 3 MB, so it is not bundled into the client. A new
    `prr.asset.get({ name: "mermaid" })` returns `mermaid/dist/mermaid.min.js` from the plugin's
    production dependencies. The client fetches it once per session, and only when a diagram is
    present. **Risk:** the compiled server bundle must be able to resolve the plugin's
    `node_modules` at runtime. If it can't, the fallback is bundling mermaid into the client.
- **Video.** The GitHub iframe's CSP has `media-src 'none'`, which blocks GitHub's `<video>`
  attachments. Change it to `media-src https: data: blob:`. `Markdown.tsx` gets a web-only
  `<video controls>` element; native shows an "Open video" link.
- **SVG.**
  - `<img src="….svg">` already works.
  - GitHub strips inline `<svg>` from `bodyHTML`, so inline SVG only matters for the native
    renderer. There it renders as a `data:image/svg+xml` image, which is script-free because it is
    an `<img>`.
- **Private-repo images (agreed).** Relative paths in a PR body (`![](docs/arch.svg)`) come back from GitHub
  as `github.com/<o>/<r>/raw|blob/<ref>/<path>` URLs. Those need a GitHub session, so they break in
  the iframe. The server rewrites them to `data:` URIs fetched through `gh api`, capped at 20
  images and 5 MB each.
- **Signed attachment URLs.** These (`private-user-images…?jwt=`) expire after about 5 minutes. The
  Overview refetches PR detail on mount when it is older than 4 minutes.

## Workstreams (Sonnet agents, parallel, disjoint files)

| # | Workstream | Owner files |
|---|---|---|
| A | Inbox stale-while-revalidate + instant PR open | `server/github/index.ts` (inbox section only), `client/data/hooks.ts`, `client/app/Inbox.tsx`, `client/app/App.tsx`, `client/app/PrScreen.tsx`, tests |
| B | Levels of detail + file boundaries in the stream | `client/review/ModuleTab.tsx`, `client/diff/rows.ts`, `client/diff/DiffRows.tsx`, `client/diff/OutlineView.tsx`, `client/diff/keyboard.ts`, `tests/diff.rows.test.ts`, `tests/diff.keyboard.test.ts` |
| C | File panel component | `client/review/FilePanel.tsx` (presentational, props contract landed first; B mounts it) |
| D | Chat context chip, no auto-send, no orientation prompt | `client/review/ChatPanel.tsx`, `server/agents/index.ts` |
| E | Overview width, change map, mermaid, video, SVG, image proxy | `client/app/OverviewTab.tsx`, `client/render/*`, new `client/render/MermaidView.tsx`, `server/assets/index.ts`, `server/github/body-images.ts`, `package.json` |
| F | Review-depth rules via the decision model | `server/analysis/depth.ts`, `server/decide/index.ts`, `server/analysis/pipeline.ts`, `client/review/depth-sync.ts`, `client/settings/SettingsScreen.tsx`, tests |

**Contracts, landed first in one commit:**

- `DetailLevel` and the `Module.recommendedLevel` / `levelSource` fields.
- `shared/levels.ts` with `defaultModuleLevel` and tests.
- The module-level store `client/review/levels.ts`.
- `PrTabContext.openChat({ context })`.
- `FilePanelProps`.
- The `prr.inbox.list` `refreshing` field and the `prr.asset.get` RPC.

Each agent passes typecheck, vitest and `check:bundle` on its own branch. I merge, integrate and
review.

## Decisions (Hari, 2026-10-02)

1. Default level: rule-based through the decision model, with the rules configured in Settings.
   The deterministic default applies when no rules are configured.
2. The decision-model question is built this round (follows from 1).
3. File rail: alternating colours.
4. Private-repo image proxy: include (it is what makes repo-relative images show at all).
5. Instant PR open from the inbox summary: include.

## Status (2026-10-02)

All workstreams (A–F, with E split into E1 overview/images and E2 rendering) merged on
`pr-review-multi-level-diffs` after the contracts commit. Integration fixes on top:

- The chat context chip is applied once per session, so the compact layout's modal remount
  doesn't re-attach a chip that was already sent.
- File panel icons use current lucide names (`FilePen`, `TriangleAlert`).
- Body images over the contents API's 1 MB inline cap fall back to the blob API.
- The inbox replaces (doesn't stack) refresh errors, and shows the real error when nothing is
  cached yet, instead of failing the RPC.
- Mermaid: a failed render no longer leaves mermaid's own error graphic at the bottom of the
  frame, and the single-diagram frame reports its content height so it can shrink.

Mermaid was verified in headless Chrome with the plugin's own builders, the sandbox (no
`allow-same-origin`) and the CSP:
- a GitHub-shaped `section[data-type="mermaid"]` (taken from real `bodyHTML`), a fenced
  single-diagram frame and agent HTML `.mermaid` all render;
- broken diagrams show their source and the error;
- `</script>` in a label is defused.

Known limits:
- The Declarations drill-down shows whole overlapping hunks, without context expansion, and
  doesn't collapse move or whitespace-only hunks.
- If the decision API fails during an analysis, the depth hash is still stored, so that PR keeps
  the default levels until a re-analyze or a rule change.
- Instant PR open needs the inbox to have loaded once in the app session.
- Nothing in this round has been exercised inside the Paseo app yet (typecheck, 569 unit tests,
  bundle check, and the headless mermaid check only).
