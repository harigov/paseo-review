import { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMermaidRuntime } from "./mermaid-runtime";
import { buildMermaidDiagramSrcDoc, renderMermaidIframe } from "./html-web";
import { isDarkSurface } from "../ui/color";

// Renders a fenced ```mermaid``` block from Markdown.tsx (the agent summary, chat, comments,
// and the PR description on non-web hosts all go through Markdown.tsx — see
// docs/plan-round4.md §5). Web: a small sandboxed iframe with the runtime and this one diagram,
// auto-sized the same way GithubHtmlView's iframe is. Native, or while the runtime is
// loading/unavailable: the same labelled code-block treatment Markdown.tsx gives any other
// fenced block, so there's never a dead space while a ~3 MB download is in flight.

let instanceCounter = 0;
const MIN_HEIGHT = 60;
const INITIAL_HEIGHT = 160;
const MAX_HEIGHT = 900;

export function MermaidView({ source, theme }: { source: string; theme: PluginSurfaceProps["theme"] }) {
  const c = theme.colors;
  const [id] = useState(() => `prr-mermaid-${(instanceCounter += 1)}-${Math.random().toString(36).slice(2)}`);
  const [rawHeight, setRawHeight] = useState(INITIAL_HEIGHT);
  const runtime = useMermaidRuntime(Platform.OS === "web");

  useEffect(() => {
    if (Platform.OS !== "web") return;
    function handler(event: any) {
      const data = event?.data;
      if (!data || data.id !== id || data.type !== "prr-html-height") return;
      if (typeof data.height === "number" && Number.isFinite(data.height)) setRawHeight(data.height);
    }
    (globalThis as any).addEventListener?.("message", handler);
    return () => {
      (globalThis as any).removeEventListener?.("message", handler);
    };
  }, [id]);

  function codeBlockFallback() {
    return (
      <View style={{ backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}>
        <Text style={{ position: "absolute", top: 4, right: 8, color: c.foregroundMuted, fontSize: 10 }}>mermaid</Text>
        <ScrollView horizontal>
          <Text selectable style={{ color: c.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 18, padding: 12 }}>
            {source}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (Platform.OS !== "web" || runtime.status !== "ready" || !runtime.script) {
    return codeBlockFallback();
  }

  const dark = isDarkSurface(c.surface0);
  const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: runtime.script, source, dark, id });
  const height = Math.min(Math.max(rawHeight, MIN_HEIGHT), MAX_HEIGHT);
  return renderMermaidIframe({ srcDoc, height });
}
