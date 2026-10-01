import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

/** One scale for every 1–5 risk/complexity/severity value in the UI. */
export function riskColor(value: number | null | undefined, c: ThemeColors): string {
  if (value === null || value === undefined) return c.foregroundMuted;
  if (value >= 4) return c.statusDanger;
  if (value >= 3) return c.statusWarning;
  return c.statusSuccess;
}

/** Small outlined label used for badges and status pills. */
export function Chip({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
      }}
    >
      <Text style={{ color, fontSize: 10 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Small filled dot, e.g. the module risk marker in the tab rail. */
export function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}
