import { useState } from "react";
import { Pressable, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { AnalyzedFile } from "../../shared/types";
import { riskColor } from "../ui/chips";
import { withAlpha } from "../ui/tokens";

export interface MinimapSegment {
  path: string;
  file: AnalyzedFile;
  count: number;
}

export interface MinimapScrollMetrics {
  offset: number;
  viewportHeight: number;
  contentHeight: number;
}

/** A 12px column to the right of the diff stream: one segment per file, sized proportionally to
 * its visible row count, coloured by risk and dimmed once viewed, with a translucent viewport
 * marker tracking the list's scroll position. Tapping a segment jumps to that file's header. */
export function Minimap({
  theme,
  segments,
  isViewed,
  scrollMetrics,
  onPressSegment,
}: {
  theme: PluginSurfaceProps["theme"];
  segments: MinimapSegment[];
  isViewed: (path: string) => boolean;
  scrollMetrics: MinimapScrollMetrics | null;
  onPressSegment: (path: string) => void;
}) {
  const c = theme.colors;
  const [height, setHeight] = useState(0);

  const markerHeight =
    scrollMetrics && scrollMetrics.contentHeight > 0 && height > 0
      ? Math.max(8, (scrollMetrics.viewportHeight / scrollMetrics.contentHeight) * height)
      : 0;
  const maxTop = Math.max(0, height - markerHeight);
  const markerTop =
    scrollMetrics && scrollMetrics.contentHeight > 0 && height > 0
      ? Math.min(maxTop, Math.max(0, (scrollMetrics.offset / scrollMetrics.contentHeight) * height))
      : 0;

  return (
    <View style={{ width: 12 }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <View style={{ flex: 1 }}>
        {segments.map((segment, index) => (
          <Pressable
            key={segment.path}
            accessibilityRole="button"
            onPress={() => onPressSegment(segment.path)}
            style={{
              flexGrow: segment.count,
              flexBasis: 0,
              minHeight: 4,
              marginBottom: index === segments.length - 1 ? 0 : 2,
              borderRadius: 2,
              backgroundColor: withAlpha(riskColor(segment.file.risk, c), isViewed(segment.path) ? 0.25 : 0.6),
            }}
          />
        ))}
      </View>
      {markerHeight > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: markerTop,
            left: 0,
            right: 0,
            height: markerHeight,
            borderRadius: 2,
            backgroundColor: withAlpha(c.foreground, 0.15),
          }}
        />
      ) : null}
    </View>
  );
}
