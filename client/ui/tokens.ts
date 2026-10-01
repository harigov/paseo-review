import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// Design tokens for the plugin UI. Hierarchy comes from tone (surface0 < surface1 < surface2),
// weight and muted vs. full foreground — not from borders. Borders are for inputs, the diff
// container and hairline separators only. Colour is reserved for meaning (status, risk, diff).

export type ThemeColors = PluginSurfaceProps["theme"]["colors"];

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 4, md: 6, lg: 8, xl: 10, pill: 999 } as const;

/** Type scale. Nothing in the UI should be smaller than `caption` (11px). */
export const font = {
  caption: { fontSize: 11, lineHeight: 16 },
  small: { fontSize: 12, lineHeight: 17 },
  body: { fontSize: 13, lineHeight: 19 },
  bodyLg: { fontSize: 14, lineHeight: 21 },
  title: { fontSize: 15, lineHeight: 21, fontWeight: "600" as const },
  heading: { fontSize: 17, lineHeight: 23, fontWeight: "700" as const },
} as const;

export const weight = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

/** Code typography per density. `lineHeight` is also the fixed row height in the diff stream. */
export const code = {
  comfortable: { fontFamily: "monospace", fontSize: 13, lineHeight: 22 },
  compact: { fontFamily: "monospace", fontSize: 12, lineHeight: 19 },
} as const;
export type DiffDensity = keyof typeof code;

/** Tone-based surface styles for a theme. */
export function surfaces(c: ThemeColors) {
  return {
    /** A grouped block on the page background. */
    card: { backgroundColor: c.surface1, borderRadius: radius.lg, padding: space.md },
    /** A block that must stand out from a card (e.g. selected, or nested in a card). */
    raised: { backgroundColor: c.surface2, borderRadius: radius.lg, padding: space.md },
    /** A thin separator between rows inside a card or list. */
    hairline: { height: 1, backgroundColor: c.border, opacity: 0.6 },
    /** Toggle / filter pill. */
    pill: (active: boolean) => ({
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: active ? c.accent : c.surface2,
    }),
    pillText: (active: boolean) => ({ ...font.small, color: active ? c.accentForeground : c.foreground }),
    /** Primary action button. */
    button: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.md, backgroundColor: c.accent },
    buttonText: { ...font.small, fontWeight: weight.semibold, color: c.accentForeground },
    /** Quiet secondary action. */
    buttonQuiet: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.md, backgroundColor: c.surface2 },
    buttonQuietText: { ...font.small, color: c.foreground },
    /** Text input. */
    input: {
      ...font.body,
      color: c.foreground,
      backgroundColor: c.surface0,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    /** Section heading inside a screen. */
    sectionTitle: { ...font.title, color: c.foreground },
    muted: { color: c.foregroundMuted },
  };
}

/** Alpha-blended tint for diff backgrounds and emphasis (colour string with CSS/RN alpha). */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const full = match[1].length === 3 ? match[1].split("").map((ch) => ch + ch).join("") : match[1];
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
