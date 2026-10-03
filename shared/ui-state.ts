import { z } from "zod";

// Persisted UI state: which PR/tab the user was last looking at, plus a small recently-opened
// PR list. Lets the surface reopen where the user left off instead of always showing the inbox.
//
// `repo` strings here are validated with the same "owner/name" pattern as `RepoSlugSchema` in
// shared/rpc.ts. It's duplicated (not imported) because shared/rpc.ts imports the schemas below
// for the `prr.ui.get` / `prr.ui.set` contracts — importing the other way too would create a
// circular module dependency between shared/rpc.ts and shared/ui-state.ts.
const RepoSlugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RepoSlugSchema = z.string().regex(RepoSlugPattern, "Expected owner/name");

export const UiLocationSchema = z.union([
  z.object({ kind: z.literal("inbox") }),
  z.object({
    kind: z.literal("pr"),
    repo: RepoSlugSchema,
    number: z.number().int().positive(),
    tab: z.string().nullable(),
  }),
]);
export type UiLocation = z.infer<typeof UiLocationSchema>;

export const RecentPrSchema = z.object({
  repo: RepoSlugSchema,
  number: z.number().int().positive(),
  title: z.string(),
  openedAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type RecentPr = z.infer<typeof RecentPrSchema>;

export const InboxFiltersSchema = z.object({
  repo: z.string().nullable().default(null),
  hideDrafts: z.boolean().default(false),
  ci: z.enum(["any", "failing", "passing"]).default("any"),
  review: z.enum(["any", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).default("any"),
  sort: z.enum(["attention", "updated", "created", "size", "severity"]).default("attention"),
  /** Which inbox group is on screen. One list, so a PR is never repeated under several headings. */
  group: z.enum(["needs_you", "recent", "mine", "review_requested", "assigned", "all"]).default("needs_you"),
});
export type InboxFilters = z.infer<typeof InboxFiltersSchema>;
export const DEFAULT_INBOX_FILTERS: InboxFilters = InboxFiltersSchema.parse({});

export const UiStateSchema = z.object({
  version: z.literal(1).default(1),
  lastLocation: UiLocationSchema.default({ kind: "inbox" }),
  // Defensive upper bound for anything we load from disk; `pushRecent` enforces the real
  // (tighter) product cap of 20 on every write, so a well-behaved client never gets near this.
  recentPrs: z.array(RecentPrSchema).max(50).default([]),
  /** Last inbox filters, restored when the inbox opens. */
  inboxFilters: InboxFiltersSchema.default(DEFAULT_INBOX_FILTERS),
});
export type UiState = z.infer<typeof UiStateSchema>;

export const DEFAULT_UI_STATE: UiState = UiStateSchema.parse({});

/** The product-level cap on recently-opened PRs (tighter than the schema's defensive max(50)). */
const MAX_RECENT_PRS = 20;

function sameRef(a: { repo: string; number: number }, b: { repo: string; number: number }): boolean {
  return a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * Moves (or inserts) a PR at the front of `recentPrs`, deduping by repo#number
 * case-insensitively, and caps the list at `MAX_RECENT_PRS`. Pure: returns a new `UiState`.
 * Preserves an existing entry's `reviewedAt` (a re-open doesn't clear review status), but
 * refreshes `title` and `openedAt` to the latest visit.
 */
export function pushRecent(
  state: UiState,
  pr: { repo: string; number: number; title: string },
  now: string,
): UiState {
  const existing = state.recentPrs.find((r) => sameRef(r, pr));
  const entry: RecentPr = {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    openedAt: now,
    reviewedAt: existing?.reviewedAt ?? null,
  };
  const rest = state.recentPrs.filter((r) => !sameRef(r, pr));
  return { ...state, recentPrs: [entry, ...rest].slice(0, MAX_RECENT_PRS) };
}

/** Stamps `reviewedAt` on the matching recent-PR entry, if any. Pure: returns a new `UiState`. */
export function markReviewed(state: UiState, repo: string, number: number, now: string): UiState {
  const ref = { repo, number };
  let changed = false;
  const recentPrs = state.recentPrs.map((r) => {
    if (!sameRef(r, ref)) return r;
    changed = true;
    return { ...r, reviewedAt: now };
  });
  return changed ? { ...state, recentPrs } : state;
}
