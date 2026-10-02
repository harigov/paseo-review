import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Analysis, DiffLayout, PrDetail, ReadingOrder } from "../../shared/types";
import type { DiffDensity } from "../ui/tokens";

/** Context attached to the chat composer (shown as a removable chip) and appended to the user's
 * next message when they press Send — never sent on its own. */
export interface ChatContext {
  /** Chip label, e.g. "Module: Analysis · 12 files". */
  label: string;
  /** Appended below the user's question on Send. */
  text: string;
}

/** Props every PR tab receives from the PR screen shell (client/app). */
export interface PrTabContext {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  navigation: PluginSurfaceProps["navigation"];
  repo: string;
  number: number;
  detail: PrDetail | null;
  analysis: Analysis | null;
  readingOrder: ReadingOrder;
  /** Filter to files changed since the viewer's last review. */
  sinceLastReview: boolean;
  /** Inline (one column) or split (old | new) file diffs. Seeded from settings; toggled per session. */
  diffLayout: DiffLayout;
  setDiffLayout(layout: DiffLayout): void;
  /** Code size / row height for diffs, seeded from settings. */
  diffDensity: DiffDensity;
  /** A file the module tab should expand and scroll to (set by "Next unviewed" or the outline); cleared by the tab once handled. */
  focusPath: string | null;
  setFocusPath(path: string | null): void;
  /** Re-fetch PR detail + analysis (e.g. after toggling viewed). */
  refresh(): void;
  /** Force a fresh analysis run (e.g. after submitting a review, so "since my last review" moves). */
  reanalyze(): void;
  /** Open the PR chat panel; `context` is attached to the composer (not sent) until the user asks something. */
  openChat(input?: { context?: ChatContext }): void;
  /** Switch the PR screen to another tab ("overview", "module:<id>", "validators", "conversations", "visual"). */
  openTab(tabId: string): void;
}

export interface ModuleTabProps extends PrTabContext {
  moduleId: string;
}
