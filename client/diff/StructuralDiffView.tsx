import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { fileStructuralDiffRpc } from "../../shared/rpc";
import type { StructuralDiff } from "../../shared/types";

type Theme = PluginSurfaceProps["theme"];

const ROW_HEIGHT = 24;
const mono = { fontFamily: "monospace" } as const;

export function StructuralDiffView({
  repo,
  number,
  path,
  headSha,
  theme,
  onShowText,
}: {
  repo: string;
  number: number;
  path: string;
  headSha: string;
  theme: Theme;
  onShowText(): void;
}) {
  const c = theme.colors;
  const rpc = useRpc(fileStructuralDiffRpc);
  const [filter, setFilter] = useState("");

  const { data, isLoading, error } = useQuery<{ diff: StructuralDiff | null }>({
    queryKey: ["prr.structural", repo, number, path, headSha],
    queryFn: () => rpc({ repo, number, path }),
  });

  const diff = data?.diff ?? null;

  const filteredEntries = useMemo(() => {
    if (!diff) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return diff.entries;
    return diff.entries.filter((entry) => entry.path.toLowerCase().includes(needle));
  }, [diff, filter]);

  const height = useMemo(() => Math.min(600, filteredEntries.length * ROW_HEIGHT || ROW_HEIGHT), [filteredEntries]);

  if (isLoading) {
    return <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 12 }}>Loading structural diff…</Text>;
  }
  if (error) {
    return <Text style={{ color: c.statusDanger, fontSize: 12, padding: 12 }}>Failed to load structural diff.</Text>;
  }
  if (!diff) {
    return (
      <View style={{ padding: 12, gap: 6 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No structural view for this file.</Text>
        <Pressable accessibilityRole="button" onPress={onShowText}>
          <Text style={{ color: c.accent, fontSize: 12 }}>Show text diff</Text>
        </Pressable>
      </View>
    );
  }
  if (diff.error) {
    return (
      <View style={{ padding: 12, gap: 6 }}>
        <Text style={{ color: c.statusWarning, fontSize: 12 }}>{diff.error}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={onShowText}
          style={{ alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.surface2, borderRadius: 6 }}
        >
          <Text style={{ color: c.foreground, fontSize: 12 }}>Show text diff</Text>
        </Pressable>
      </View>
    );
  }
  if (diff.entries.length === 0) {
    return <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 12 }}>No structural changes.</Text>;
  }

  const added = diff.entries.filter((entry) => entry.change === "added").length;
  const removed = diff.entries.filter((entry) => entry.change === "removed").length;
  const changed = diff.entries.filter((entry) => entry.change === "changed").length;

  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 5, overflow: "hidden" }}>
      <View style={{ padding: 8, gap: 6, backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          {added} added · {removed} removed · {changed} changed
          {diff.format ? ` · ${diff.format} lockfile` : ""}
          {diff.truncated ? " · (truncated)" : ""}
        </Text>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter by path…"
          style={{
            fontSize: 12,
            color: c.foreground,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 4,
          }}
        />
      </View>
      <FlatList
        data={filteredEntries}
        keyExtractor={(entry, index) => `${entry.path}-${index}`}
        renderItem={({ item }) => {
          const oldTint = item.change === "removed" || item.change === "changed" ? c.statusDanger : null;
          const newTint = item.change === "added" || item.change === "changed" ? c.statusSuccess : null;
          return (
            <View style={{ flexDirection: "row", minHeight: ROW_HEIGHT, alignItems: "center", borderBottomWidth: 1, borderColor: c.border }}>
              <Text selectable numberOfLines={1} style={{ ...mono, flex: 2, fontSize: 12, color: c.foreground, paddingHorizontal: 6 }}>
                {item.path}
              </Text>
              <View style={{ flex: 1 }}>
                {oldTint ? (
                  <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: oldTint, opacity: 0.12 }} />
                ) : null}
                <Text selectable numberOfLines={1} style={{ ...mono, fontSize: 11, color: c.foregroundMuted, paddingHorizontal: 6 }}>
                  {item.oldLine !== null ? `L${item.oldLine} ` : ""}
                  {item.oldValue ?? ""}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                {newTint ? (
                  <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: newTint, opacity: 0.12 }} />
                ) : null}
                <Text selectable numberOfLines={1} style={{ ...mono, fontSize: 11, color: c.foregroundMuted, paddingHorizontal: 6 }}>
                  {item.newLine !== null ? `L${item.newLine} ` : ""}
                  {item.newValue ?? ""}
                </Text>
              </View>
            </View>
          );
        }}
        style={{ height, backgroundColor: c.surface0 }}
      />
    </View>
  );
}
