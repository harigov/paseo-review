# PR Review — Round 3: reviewer efficiency and look & feel

Builds on `docs/plan-round2.md`. Accepted scope: the reviewer-efficiency items, design tokens,
tone-over-borders hierarchy, diff polish, loading/empty states, and the Conversations tab.
Not in scope this round: header compression, hiding reviewer-irrelevant jargon.

## Design tokens (`client/ui/tokens.ts`, `client/ui/states.tsx`)

- `space` 4/8/12/16/24, `radius` 4/6/8/10/pill, `font` caption 11 → heading 17, `code` per
  density (comfortable 13/22, compact 12/19), `surfaces(c)` for card / raised / hairline / pill
  / button / input, `withAlpha` for tints. Nothing smaller than 11 px.
- Hierarchy through tone and weight: cards are `surface1` blocks with radius and no border;
  nested emphasis is `surface2`; rows inside a card separate with a 60 % hairline or spacing;
  borders only on inputs and the diff container. Colour only for status, risk and diff.
- `Skeleton`, `EmptyState`, `InlineLoading`, `ErrorState` replace bare "Loading…" / blank areas.

## Workstreams

| # | Workstream | Owner files |
|---|---|---|
| S1 | Continuous diff stream per module: one virtualized list (file headers, outline, hunks, lines, threads, drafts, inline composer), sticky file headers, right-hand minimap, prefetch of the next file's diff, "mark module viewed", `focusPath` handling, tokens + diff polish | `client/review/ModuleTab.tsx`, `client/diff/FileDiffView.tsx` → `client/diff/rows.ts`, `client/diff/DiffRows.tsx`, `client/diff/Minimap.tsx`, `client/diff/InlineComposer.tsx`, `tests/diff.rows.test.ts` |
| W | Word-level (intra-line) diff helper | `client/diff/intraline.ts`, `tests/diff.intraline.test.ts` |
| I2 | Inbox: tokens/tone, hide empty sections, avatars and labels, remembered filters, "Needs you" section, skeleton and empty states | `client/app/Inbox.tsx` |
| C2 | Conversations (collapse resolved, reply on demand), Status panel, Overview, Validators: tokens/tone, loading/empty states, theme fix for stat labels | `client/review/ConversationsTab.tsx`, `client/review/StatusPanel.tsx`, `client/app/OverviewTab.tsx`, `client/review/ValidatorsTab.tsx`, `client/review/ValidatorResultsList.tsx`, `client/app/VisualTab.tsx` |
| P | PR screen: review progress in the header ("12 of 27 viewed · 3 drafts"), "Next unviewed", tab-rail progress bars, tokens/tone, loading states; density setting | `client/app/PrScreen.tsx`, `client/settings/SettingsScreen.tsx`, `client/review/ReviewSubmitButton.tsx` |
| S2 (wave 2, after S1) | Keyboard navigation, expand-context rows, intra-line highlighting in the stream | S1's files |

## Contracts landed first

- `settings.diffDensity`, `PrTabContext.diffDensity / focusPath / setFocusPath`.
- `UiState.inboxFilters` with `useInboxFilters` / `rememberInboxFilters`.
- `prr.file.lines` (lines of a file at head or merge base, ≤ 500 per call) for context expansion.
- Server-side LRU for structural diffs keyed by merge base, head and path.

## Diff stream (S1) design

- Row model in `rows.ts` (pure, unit-tested): `fileHeader`, `fileMeta`, `outline`, `structural`,
  `truncated`, `hunkHeader`, `collapsed`, `line` / `pair`, `thread`, `finding`, `draft`,
  `composer`, `expandContext` (placeholder rows for S2). Rows carry the file path so renderers
  and the minimap can group them. `stickyHeaderIndices` = file header rows.
- Highlighting stays lazy per hunk; row height is `code[density].lineHeight` for code rows.
- Minimap: a 12 px column on the right; one segment per file sized by its visible row count,
  coloured by risk, dimmed when viewed; a viewport marker from `onScroll`; tap → `scrollToIndex`.
- Inline composer row below the target line (Add to review / Comment now / Save / Cancel); only
  one composer at a time; Escape or Cancel closes it.
- Hunk header shows the function context and the new-side line range instead of the raw `@@`.
- Diff polish: row hover highlight (web), gutters tinted with the add/del colour at 0.2, moved
  lines dimmed as today, whitespace markers kept.
- `focusPath`: expand the file, scroll its header to the top, then `setFocusPath(null)`.
- Prefetch: when a file expands, `queryClient.prefetchQuery` for the next unviewed file's diff.

## Keyboard navigation (S2, web)

`j` / `k` next / previous file (scroll + highlight), `v` mark viewed and jump to the next
unviewed, `n` next unresolved item (open thread or failing finding), `[` / `]` previous / next
hunk, `↑` / `↓` move the line cursor, `c` comment at the cursor, `e` expand/collapse the current
file, `?` shortcut sheet. Ignored while an input is focused. `/` focuses search in the inbox.

## Status (2026-10-01)

All workstreams merged on `paseo-pr-review-ui-enhancements`. Changes versus the design above:
`FileDiff.totalLines` replaced the client-side line-count probe; `FILE_LINES_MAX` is shared
between server and client; the per-file "Viewed & next" action was kept on the sticky header
alongside the module-level "Mark module viewed"; Stop/interrupt for chat is still unavailable
in the plugin client API.

Known limits: context expansion treats a gap that spans a dropped (over-budget) hunk as
unsafe and does not expand it; the keyboard layer is web only; nothing in this round has been
exercised inside the Paseo app yet (typecheck, unit tests and bundle only).
