import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { OutlineChange, OutlineEntry } from "../../shared/types";
import { Chip } from "../ui/chips";
import { outlineSummary } from "./rows";

type Theme = PluginSurfaceProps["theme"];
type ThemeColors = Theme["colors"];

const mono = { fontFamily: "monospace", fontSize: 11 } as const;

/** `rows.ts` is the single source for this (it's a pure module that other pure diff logic also
 * needs); re-exported here so existing consumers of `OutlineView` keep working. */
export { outlineSummary };

/** Exported for `DiffRows.tsx`'s `decl` row (Declarations level), which uses the same change
 * colour coding as this outline list. */
export function changeColor(change: OutlineChange, c: ThemeColors): string {
  switch (change) {
    case "added":
      return c.statusSuccess;
    case "removed":
      return c.statusDanger;
    case "signature":
      return c.statusWarning;
    case "renamed":
    case "moved":
      return c.accent;
    case "modified":
    default:
      return c.foregroundMuted;
  }
}

/** "L12–40", preferring the new range and falling back to the old one (e.g. for removed entries). */
function lineRangeLabel(entry: OutlineEntry): string | null {
  const start = entry.newStart ?? entry.oldStart;
  const end = entry.newEnd ?? entry.oldEnd;
  if (start === null || end === null) return null;
  return `L${start}–${end}`;
}

/** For renamed/moved entries, where the other half of the declaration lives. */
function counterpartLabel(entry: OutlineEntry): string | null {
  if (!entry.counterpart) return null;
  if (entry.change === "renamed") return `← from ${entry.counterpart.name}`;
  if (entry.change === "moved") {
    // Moved declarations are reported on both sides; whichever half is missing its own range
    // tells us whether this is the departure point or the arrival point.
    if (entry.newStart === null) return `moved to ${entry.counterpart.path}`;
    if (entry.oldStart === null) return `moved from ${entry.counterpart.path}`;
  }
  return null;
}

function OutlineRow({
  entry,
  theme,
  onSelect,
}: {
  entry: OutlineEntry;
  theme: Theme;
  onSelect?: (entry: OutlineEntry) => void;
}) {
  const c = theme.colors;
  const range = lineRangeLabel(entry);
  const counterpart = counterpartLabel(entry);

  const body = (
    <View style={{ paddingVertical: 6, paddingHorizontal: 8, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Chip label={entry.change} color={changeColor(entry.change, c)} />
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{entry.kind}</Text>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
          {entry.name}
        </Text>
        {entry.exported ? <Chip label="exported" color={c.accent} /> : null}
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{`+/- ${entry.changedLines}`}</Text>
        {range ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{range}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {entry.change === "signature" ? (
          <Text numberOfLines={1} style={{ flex: 1 }}>
            <Text style={{ ...mono, color: c.foregroundMuted, textDecorationLine: "line-through" }}>{entry.oldSignature ?? ""}</Text>
            <Text style={{ ...mono, color: c.foregroundMuted }}>{" → "}</Text>
            <Text style={{ ...mono, color: c.foregroundMuted }}>{entry.signature}</Text>
          </Text>
        ) : (
          <Text numberOfLines={1} style={{ ...mono, color: c.foregroundMuted, flex: 1 }}>
            {counterpart ?? entry.signature}
          </Text>
        )}
      </View>
    </View>
  );

  if (!onSelect) {
    return <View style={{ borderBottomWidth: 1, borderColor: c.border }}>{body}</View>;
  }
  return (
    <Pressable accessibilityRole="button" onPress={() => onSelect(entry)} style={{ borderBottomWidth: 1, borderColor: c.border }}>
      {body}
    </Pressable>
  );
}

export function OutlineView({
  entries,
  theme,
  onSelect,
}: {
  entries: OutlineEntry[];
  theme: Theme;
  onSelect?: (entry: OutlineEntry) => void;
}) {
  const c = theme.colors;
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 5, overflow: "hidden" }}>
      {entries.map((entry, index) => (
        <OutlineRow key={`${entry.change}-${entry.name}-${index}`} entry={entry} theme={theme} onSelect={onSelect} />
      ))}
    </View>
  );
}
