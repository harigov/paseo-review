import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { font, radius, space, surfaces } from "./tokens";

type Theme = PluginSurfaceProps["theme"];

/** Placeholder rows shown while content loads, instead of a bare "Loading…" string. */
export function Skeleton({ theme, rows = 3, lineHeight = 14, widths }: { theme: Theme; rows?: number; lineHeight?: number; widths?: Array<number | `${number}%`> }) {
  const c = theme.colors;
  const pattern: Array<number | `${number}%`> = widths ?? ["72%", "48%", "60%", "36%"];
  return (
    <View style={{ gap: space.sm, padding: space.md }} accessibilityLabel="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ height: lineHeight, width: pattern[i % pattern.length], borderRadius: radius.sm, backgroundColor: c.surface2, opacity: 0.7 }} />
      ))}
    </View>
  );
}

/** Purposeful empty state: an icon, a short title and an optional hint or action. */
export function EmptyState({
  theme,
  icon = "Inbox",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  theme: Theme;
  icon?: string;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  return (
    <View style={{ alignItems: "center", gap: space.sm, padding: space.xl }}>
      <Icon name={icon} size={22} color={c.foregroundMuted} />
      <Text style={{ ...font.body, fontWeight: "600", color: c.foreground, textAlign: "center" }}>{title}</Text>
      {hint ? <Text style={{ ...font.small, color: c.foregroundMuted, textAlign: "center", maxWidth: 360 }}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={{ ...s.buttonQuiet, marginTop: space.xs }}>
          <Text style={s.buttonQuietText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One-line inline loading indicator for small regions. */
export function InlineLoading({ theme, label = "Loading…" }: { theme: Theme; label?: string }) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.foregroundMuted, opacity: 0.6 }} />
      <Text style={{ ...font.small, color: c.foregroundMuted }}>{label}</Text>
    </View>
  );
}

/** Error state with retry. */
export function ErrorState({ theme, message, onRetry, children }: { theme: Theme; message: string; onRetry?: () => void; children?: ReactNode }) {
  const c = theme.colors;
  const s = surfaces(c);
  return (
    <View style={{ gap: space.sm, padding: space.lg, alignItems: "flex-start" }}>
      <Text style={{ ...font.body, color: c.statusDanger }}>{message}</Text>
      {children}
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={s.buttonQuiet}>
          <Text style={s.buttonQuietText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
