import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { copyText } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { renderHtmlIframe, buildMermaidRunBootstrapScript } from "./html-web";
import { hasMermaidClass } from "./html-subset";
import { useMermaidRuntime } from "./mermaid-runtime";
import { isDarkSurface } from "../ui/color";

/**
 * Renders a self-contained HTML document. On web/desktop this is a sandboxed iframe (CSP
 * locked down to inline script/style only, no network). On native there is no safe HTML
 * renderer, so we show a note plus a "Copy HTML" action instead.
 */
export function HtmlView({
  html,
  theme,
  height = 640,
}: {
  html: string;
  theme: PluginSurfaceProps["theme"];
  height?: number | "flex";
}) {
  const c = theme.colors;
  const [copied, setCopied] = useState(false);
  const hasMermaid = useMemo(() => hasMermaidClass(html), [html]);
  const mermaidRuntime = useMermaidRuntime(Platform.OS === "web" && hasMermaid);

  if (Platform.OS === "web") {
    const withMermaid =
      hasMermaid && mermaidRuntime.status === "ready" && mermaidRuntime.script
        ? `${html}<script>${mermaidRuntime.script}</script><script>${buildMermaidRunBootstrapScript(isDarkSurface(c.surface0))}</script>`
        : html;
    return renderHtmlIframe(withMermaid, height);
  }

  return (
    <View style={{ gap: 10, padding: 16, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
      <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>
        Rich HTML view is available on desktop/web.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void copyText(html)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {});
        }}
        style={({ pressed }) => ({
          alignSelf: "flex-start",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: pressed ? c.surface2 : c.surface0,
          borderWidth: 1,
          borderColor: c.border,
        })}
      >
        <Text style={{ color: c.foreground, fontSize: 13 }}>{copied ? "Copied" : "Copy HTML"}</Text>
      </Pressable>
    </View>
  );
}
