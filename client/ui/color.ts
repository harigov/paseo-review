/** Parses `#rgb` / `#rrggbb` into components; null (rather than a guess) for any other format. */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const full = match[1].length === 3 ? match[1].split("").map((ch) => ch + ch).join("") : match[1];
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** Relative luminance (0–255 scale); null when the colour isn't a parseable hex string. */
export function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722;
}

/**
 * Whether a theme surface colour is dark. Fails open to "light" when the colour can't be parsed
 * (PluginTheme.colors is typed as plain `string`, with no guaranteed format).
 */
export function isDarkSurface(hex: string): boolean {
  const value = luminance(hex);
  return value !== null && value < 128;
}
