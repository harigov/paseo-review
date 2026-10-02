/** Compact relative age for timestamps: "just now", "5m", "3h", "2d", "4mo". */
export function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

/** "3m ago", or "just now" (never "just now ago"). */
export function agoLabel(iso: string): string {
  const age = relativeAge(iso);
  return age === "just now" ? age : `${age} ago`;
}
