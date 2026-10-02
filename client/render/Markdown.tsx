import { marked, type Token, type Tokens } from "marked";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Linking, Platform, Pressable, Text, View, type TextStyle } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { decodeEntities, findVideoSrc, parseHtmlFragment, svgDataUri, svgDimensions, type HtmlNode } from "./html-subset";
import { detectAlert, linkifyGithubRefs, stripHtmlComments, type AlertKind } from "./markdown-text";
import { MermaidView } from "./MermaidView";
import { renderVideoElement } from "./html-web";

// Ported from the MIT Ironside Software pull-requests-paseo-plugin (client/markdown.tsx),
// then substantially rewritten to additionally render GitHub's sanitised HTML subset (the kind
// review bots like Cursor Bugbot, Copilot and CodeRabbit embed in comment bodies): collapsible
// <details>, inline formatting tags, images, and tables described in raw HTML rather than
// markdown.

type Theme = PluginSurfaceProps["theme"];
type Colors = Theme["colors"];
type HtmlElement = Extract<HtmlNode, { type: "element" }>;

const BLOCK_GAP = 10;

// React Native's URL polyfill doesn't implement protocol/username/password, so links are
// checked with string rules instead of `new URL`. Only https links without credentials open;
// root-relative and relative links resolve against the PR's GitHub URL.
function safeLink(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    const match = /^https:\/\/([^/?#]*)/i.exec(absolute);
    if (!match || match[1]!.includes("@") || !match[1]) return null;
    return absolute;
  }
  const base = /^(https:\/\/[^/?#@]+)(\/[^?#]*)?/i.exec(baseUrl);
  if (!base) return null;
  if (trimmed.startsWith("/")) return `${base[1]}${trimmed}`;
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) return `${base[1]}${base[2] ?? ""}${trimmed}`;
  const dir = (base[2] ?? "/").replace(/[^/]*$/, "");
  return `${base[1]}${dir}${trimmed}`;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return node.type === "element";
}

const ALERT_META: Record<AlertKind, { icon: string; label: string; color: (c: Colors) => string }> = {
  NOTE: { icon: "Info", label: "Note", color: (c) => c.accent },
  TIP: { icon: "Lightbulb", label: "Tip", color: (c) => c.statusSuccess },
  IMPORTANT: { icon: "MessageSquareWarning", label: "Important", color: (c) => c.accent },
  WARNING: { icon: "TriangleAlert", label: "Warning", color: (c) => c.statusWarning },
  CAUTION: { icon: "OctagonAlert", label: "Caution", color: (c) => c.statusDanger },
};

const VOID_INLINE_TAGS = new Set(["br", "hr", "img", "input", "source", "meta", "link", "col", "wbr"]);
const BLOCK_HTML_TAGS = new Set([
  "div", "p", "section", "center", "ul", "ol", "li", "blockquote", "pre", "table",
  "details", "summary", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "video", "svg",
]);

/** Inline style contributed by a formatting tag; `code`/`kbd` also get a background. */
function styleForTag(tag: string, c: Colors): TextStyle | null {
  switch (tag) {
    case "b":
    case "strong":
      return { fontWeight: "600" };
    case "i":
    case "em":
      return { fontStyle: "italic" };
    case "u":
      return { textDecorationLine: "underline" };
    case "del":
    case "s":
    case "strike":
      return { textDecorationLine: "line-through" };
    case "code":
      return { fontFamily: "monospace", fontSize: 12.5, backgroundColor: c.surface2, paddingHorizontal: 3 };
    case "kbd":
      return {
        fontFamily: "monospace",
        fontSize: 12.5,
        backgroundColor: c.surface2,
        paddingHorizontal: 3,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 3,
      };
    case "sup":
    case "sub":
      return { fontSize: 10 };
    case "span":
    case "font":
      return {};
    default:
      return null;
  }
}

function headingStyle(depth: number, c: Colors): TextStyle {
  if (depth === 1) {
    return { color: c.foreground, fontSize: 22, fontWeight: "700", borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 6, marginTop: 6 };
  }
  if (depth === 2) {
    return { color: c.foreground, fontSize: 19, fontWeight: "700", borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 6, marginTop: 6 };
  }
  if (depth === 3) return { color: c.foreground, fontSize: 16, fontWeight: "600", marginTop: 2 };
  return { color: c.foreground, fontSize: 14, fontWeight: "600", marginTop: 2 };
}

/** One entry in the ambient inline formatting stack threaded through `inline`/`renderHtmlInline`. */
interface InlineFrame {
  tag: string;
  style?: TextStyle;
  href?: string;
}

function mergeStyles(stack: InlineFrame[]): TextStyle {
  return stack.reduce<TextStyle>((acc, frame) => (frame.style ? { ...acc, ...frame.style } : acc), {});
}

function currentHref(stack: InlineFrame[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const href = stack[i]!.href;
    if (href) return href;
  }
  return null;
}

function parseDim(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/**
 * Renders an `<img>`/markdown image. In "block" mode (a standalone image with no intrinsic
 * size given) it measures with `Image.getSize`, shows a placeholder until measured, and scales
 * to fit its container (capped at 480px tall) while preserving aspect ratio. In "inline" mode
 * (mixed in with running text, where a measuring `View` can't be nested inside the parent
 * `Text`) it skips measuring: an image with explicit width/height renders immediately, one
 * without just falls back to a link with its alt text. Either way, explicit width/height
 * attributes always win, and an image inside a link is wrapped so the whole thing is tappable.
 */
function AutoImage({
  src,
  alt,
  theme,
  baseUrl,
  explicitWidth,
  explicitHeight,
  href,
  mode,
}: {
  src: string;
  alt: string;
  theme: Theme;
  baseUrl: string;
  explicitWidth?: number;
  explicitHeight?: number;
  href?: string | null;
  mode: "block" | "inline";
}) {
  const c = theme.colors;
  const toast = useToast();
  const uri = safeLink(src, baseUrl);
  const hasExplicit = Boolean(explicitWidth && explicitHeight);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (mode !== "block" || hasExplicit || !uri) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (!cancelled) setMeasured({ width, height });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri, hasExplicit, mode]);

  function openLink(target: string) {
    const url = safeLink(target, baseUrl);
    if (url) void Linking.openURL(url).catch(() => toast.error("Could not open link."));
  }

  if (!uri) {
    return alt ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{alt}</Text> : null;
  }

  if (hasExplicit) {
    const img = (
      <Image source={{ uri }} resizeMode="contain" accessibilityLabel={alt} style={{ width: explicitWidth, height: explicitHeight }} />
    );
    return href ? (
      <Text accessibilityRole="button" onPress={() => openLink(href)}>
        {img}
      </Text>
    ) : (
      img
    );
  }

  if (mode === "inline") {
    return (
      <Text accessibilityRole="link" onPress={() => openLink(uri)} style={{ color: c.accent, fontSize: 12 }}>
        {alt || "View image"}
      </Text>
    );
  }

  if (failed) {
    return (
      <Text accessibilityRole="link" onPress={() => openLink(uri)} style={{ color: c.accent, fontSize: 12 }}>
        {alt || "View image"}
      </Text>
    );
  }

  if (!measured) {
    return (
      <View
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        style={{ height: 120, backgroundColor: c.surface1, borderRadius: 6 }}
      />
    );
  }

  const width = Math.min(measured.width, containerWidth || measured.width);
  const scale = measured.width > 0 ? width / measured.width : 1;
  const height = Math.min(measured.height * scale, 480);
  const img = <Image source={{ uri }} resizeMode="contain" accessibilityLabel={alt} style={{ width, height }} />;
  return (
    <View onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      {href ? (
        <Pressable accessibilityRole="button" onPress={() => openLink(href)}>
          {img}
        </Pressable>
      ) : (
        img
      )}
    </View>
  );
}

/** A `<details>` block: a tappable summary row (chevron + summary text) that reveals its body. */
function CollapsibleDetails({
  summary,
  defaultOpen,
  theme,
  children,
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  theme: Theme;
  children: ReactNode;
}) {
  const c = theme.colors;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, backgroundColor: c.surface1 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
        <View style={{ flex: 1 }}>{summary}</View>
      </Pressable>
      {open ? <View style={{ padding: 10, gap: BLOCK_GAP }}>{children}</View> : null}
    </View>
  );
}

interface TableCellData {
  node: ReactNode;
  text: string;
}

/** Shared table grid: column widths derived from the longest cell text in that column. */
function renderTableGrid(c: Colors, header: TableCellData[], rows: TableCellData[][], key: string | number): ReactNode {
  const columnCount = header.length;
  const widths: number[] = [];
  for (let col = 0; col < columnCount; col++) {
    let longest = header[col]?.text.length ?? 0;
    for (const row of rows) longest = Math.max(longest, row[col]?.text.length ?? 0);
    widths.push(Math.min(320, Math.max(80, longest * 7 + 24)));
  }
  return (
    <ScrollView key={key} horizontal>
      <View>
        <View style={{ flexDirection: "row", backgroundColor: c.surface1 }}>
          {header.map((cell, col) => (
            <View key={col} style={{ width: widths[col], padding: 8, borderWidth: 0.5, borderColor: c.border }}>
              <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{cell.node}</Text>
            </View>
          ))}
        </View>
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: "row", backgroundColor: c.surface0 }}>
            {row.map((cell, col) => (
              <View key={col} style={{ width: widths[col], padding: 8, borderWidth: 0.5, borderColor: c.border }}>
                <Text style={{ color: c.foreground, fontSize: 13 }}>{cell.node}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function collectText(nodes: HtmlNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : collectText(n.children))).join("");
}

/** Finds the nested `<img>` inside a `<picture>` (ignoring its `<source>` children). */
function imgInPicture(picture: HtmlElement): HtmlElement | null {
  return picture.children.find((n): n is HtmlElement => isElement(n) && n.tag === "img") ?? null;
}

export function Markdown({ body, theme, baseUrl }: { body: string; theme: Theme; baseUrl: string }) {
  const c = theme.colors;
  const toast = useToast();
  // GitHub renders a single newline inside a comment/description as a line break, so `breaks`
  // must be on; HTML comments (bot markers, hidden metadata) are stripped before lexing so
  // they never surface as stray text or confuse the <details>-spanning logic below.
  const tokens = useMemo(() => marked.lexer(stripHtmlComments(body), { gfm: true, breaks: true }), [body]);
  const text: TextStyle = { color: c.foreground, fontSize: 14, lineHeight: 22 };

  function open(href: string) {
    const url = safeLink(href, baseUrl);
    if (url) void Linking.openURL(url).catch(() => toast.error("Could not open link."));
  }

  function renderLeaf(raw: string, key: string, stack: InlineFrame[]): ReactNode {
    const decoded = decodeEntities(raw);
    const mergedStyle = mergeStyles(stack);
    const href = currentHref(stack);
    if (href) {
      const url = safeLink(href, baseUrl);
      return (
        <Text
          key={key}
          accessibilityRole={url ? "link" : undefined}
          onPress={url ? () => open(href) : undefined}
          style={{ ...text, ...(url ? { color: c.accent, textDecorationLine: "underline" as const } : {}), ...mergedStyle }}
        >
          {decoded}
        </Text>
      );
    }
    const segments = linkifyGithubRefs(decoded, baseUrl);
    const hasStyle = Object.keys(mergedStyle).length > 0;
    if (segments.length === 1 && !segments[0]!.href) {
      return hasStyle ? (
        <Text key={key} style={{ ...text, ...mergedStyle }}>
          {decoded}
        </Text>
      ) : (
        decoded
      );
    }
    return (
      <Text key={key} style={{ ...text, ...mergedStyle }}>
        {segments.map((seg, si) =>
          seg.href ? (
            <Text key={si} accessibilityRole="link" onPress={() => open(seg.href!)} style={{ color: c.accent }}>
              {seg.text}
            </Text>
          ) : (
            <Fragment key={si}>{seg.text}</Fragment>
          ),
        )}
      </Text>
    );
  }

  // --- marked-token inline rendering (paragraphs, headings, table cells, list items) --------

  function inline(items: Token[], stack: InlineFrame[] = []): ReactNode[] {
    const nodes: ReactNode[] = [];
    items.forEach((token, idx) => {
      const key = `i${idx}`;

      if (token.type === "html") {
        const raw = token.raw;
        const trimmed = raw.trim();
        if (trimmed.startsWith("</")) {
          const match = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed);
          const tagName = match?.[1]?.toLowerCase();
          if (tagName) {
            for (let s = stack.length - 1; s >= 0; s--) {
              if (stack[s]!.tag === tagName) {
                stack.length = s;
                break;
              }
            }
          }
          return;
        }
        if (/^<br\s*\/?>/i.test(trimmed)) {
          nodes.push("\n");
          return;
        }
        const parsedNode = parseHtmlFragment(raw).find(isElement);
        if (!parsedNode) return;
        const { tag, attrs } = parsedNode;
        const leaf = VOID_INLINE_TAGS.has(tag) || trimmed.endsWith("/>");
        if (tag === "img") {
          nodes.push(
            <AutoImage
              key={key}
              mode="inline"
              src={attrs.src ?? ""}
              alt={decodeEntities(attrs.alt ?? "")}
              theme={theme}
              baseUrl={baseUrl}
              explicitWidth={parseDim(attrs.width)}
              explicitHeight={parseDim(attrs.height)}
              href={currentHref(stack)}
            />,
          );
          return;
        }
        if (tag === "a") {
          if (!leaf) stack.push({ tag: "a", href: attrs.href });
          return;
        }
        if (!leaf) stack.push({ tag, style: styleForTag(tag, c) ?? undefined });
        return;
      }

      switch (token.type) {
        case "br":
          nodes.push("\n");
          return;
        case "codespan": {
          const style: TextStyle = { ...mergeStyles(stack), fontFamily: "monospace", fontSize: 12.5, backgroundColor: c.surface2, paddingHorizontal: 3 };
          nodes.push(
            <Text key={key} style={{ ...text, ...style }}>
              {token.text}
            </Text>,
          );
          return;
        }
        case "strong":
        case "em":
        case "del": {
          const style: TextStyle =
            token.type === "strong" ? { fontWeight: "600" } : token.type === "em" ? { fontStyle: "italic" } : { textDecorationLine: "line-through" };
          stack.push({ tag: `native-${token.type}`, style });
          const rendered = inline(token.tokens ?? [], stack);
          stack.pop();
          nodes.push(<Fragment key={key}>{rendered}</Fragment>);
          return;
        }
        case "link": {
          stack.push({ tag: "native-a", href: token.href });
          const rendered = inline(token.tokens ?? [], stack);
          stack.pop();
          nodes.push(<Fragment key={key}>{rendered}</Fragment>);
          return;
        }
        case "image":
          nodes.push(
            <AutoImage
              key={key}
              mode="inline"
              src={token.href}
              alt={token.text}
              theme={theme}
              baseUrl={baseUrl}
              href={currentHref(stack)}
            />,
          );
          return;
        case "escape":
        case "text": {
          const withTokens = token as Tokens.Text | Tokens.Escape;
          if ("tokens" in withTokens && withTokens.tokens && withTokens.tokens.length > 0) {
            nodes.push(<Fragment key={key}>{inline(withTokens.tokens, stack)}</Fragment>);
          } else {
            nodes.push(renderLeaf(withTokens.text, key, stack));
          }
          return;
        }
        default:
          if ("raw" in token) nodes.push(renderLeaf(token.raw, key, stack));
      }
    });
    return nodes;
  }

  // --- HtmlNode inline rendering (content inside <details>/<div>/<table> etc from raw HTML) --

  function renderHtmlInline(nodes: HtmlNode[], stack: InlineFrame[] = []): ReactNode[] {
    const out: ReactNode[] = [];
    nodes.forEach((node, idx) => {
      const key = `hi${idx}`;
      if (node.type === "text") {
        out.push(renderLeaf(node.text, key, stack));
        return;
      }
      const { tag, attrs, children } = node;
      if (tag === "br") {
        out.push("\n");
        return;
      }
      if (tag === "picture") {
        const img = imgInPicture(node);
        if (img) out.push(...renderHtmlInline([img], stack));
        return;
      }
      if (tag === "img") {
        out.push(
          <AutoImage
            key={key}
            mode="inline"
            src={attrs.src ?? ""}
            alt={decodeEntities(attrs.alt ?? "")}
            theme={theme}
            baseUrl={baseUrl}
            explicitWidth={parseDim(attrs.width)}
            explicitHeight={parseDim(attrs.height)}
            href={currentHref(stack)}
          />,
        );
        return;
      }
      if (tag === "input") {
        if ((attrs.type ?? "").toLowerCase() === "checkbox") {
          out.push(<Icon key={key} name={"checked" in attrs ? "SquareCheck" : "Square"} size={13} color={c.foregroundMuted} />);
        }
        return;
      }
      if (tag === "a") {
        stack.push({ tag: "a", href: attrs.href });
        out.push(...renderHtmlInline(children, stack));
        stack.pop();
        return;
      }
      const style = styleForTag(tag, c);
      if (style) {
        stack.push({ tag, style });
        out.push(...renderHtmlInline(children, stack));
        stack.pop();
        return;
      }
      // Unknown inline tag: render its children only.
      out.push(...renderHtmlInline(children, stack));
    });
    return out;
  }

  /** True for an element tag that gets its own block-level layout (as opposed to flowing
   * inline as part of a text run — text, formatting tags, links, images). */
  function isBlockElement(node: HtmlNode): node is HtmlElement {
    return node.type === "element" && BLOCK_HTML_TAGS.has(node.tag);
  }

  /** Resolves a lone `<img>`/`<picture>`/`<a>`-wrapping-an-image node for block-level display. */
  function resolveBlockImage(node: HtmlElement): { src: string; alt: string; width?: number; height?: number; href?: string } | null {
    let href: string | undefined;
    let imgNode: HtmlElement | null = node;
    if (node.tag === "a") {
      href = node.attrs.href;
      const child = node.children.find((n): n is HtmlElement => isElement(n) && (n.tag === "img" || n.tag === "picture"));
      imgNode = child ? (child.tag === "picture" ? imgInPicture(child) : child) : null;
    } else if (node.tag === "picture") {
      imgNode = imgInPicture(node);
    } else if (node.tag !== "img") {
      imgNode = null;
    }
    if (!imgNode) return null;
    return {
      src: imgNode.attrs.src ?? "",
      alt: decodeEntities(imgNode.attrs.alt ?? ""),
      width: parseDim(imgNode.attrs.width),
      height: parseDim(imgNode.attrs.height),
      href,
    };
  }

  function renderHtmlListItem(item: HtmlElement, ordered: boolean, index: number, key: string, depth: number): ReactNode {
    const checkbox = item.children.find((n): n is HtmlElement => isElement(n) && n.tag === "input" && (n.attrs.type ?? "").toLowerCase() === "checkbox");
    const rest = checkbox ? item.children.filter((n) => n !== checkbox) : item.children;
    const marker = checkbox ? (
      <Icon name={"checked" in checkbox.attrs ? "SquareCheck" : "Square"} size={13} color={c.foregroundMuted} />
    ) : (
      <Text style={{ ...text, color: c.foregroundMuted, width: 20 }}>{ordered ? `${index + 1}.` : "•"}</Text>
    );
    return (
      <View key={key} style={{ flexDirection: "row", gap: 10 }}>
        {marker}
        <View style={{ flex: 1, gap: 6 }}>{renderHtmlBlocks(rest, key, depth + 1)}</View>
      </View>
    );
  }

  function renderHtmlTable(node: HtmlElement, key: string): ReactNode {
    const rows: HtmlElement[] = [];
    const collectRows = (n: HtmlNode) => {
      if (!isElement(n)) return;
      if (n.tag === "tr") {
        rows.push(n);
        return;
      }
      n.children.forEach(collectRows);
    };
    node.children.forEach(collectRows);
    if (rows.length === 0) return null;
    const toCell = (cellNode: HtmlElement): TableCellData => ({
      node: <Fragment>{renderHtmlInline(cellNode.children)}</Fragment>,
      text: collectText(cellNode.children),
    });
    const cellsOf = (row: HtmlElement) => row.children.filter((n): n is HtmlElement => isElement(n) && (n.tag === "td" || n.tag === "th")).map(toCell);
    const [headerRow, ...bodyRows] = rows;
    return renderTableGrid(c, cellsOf(headerRow!), bodyRows.map(cellsOf), key);
  }

  function renderHtmlBlockNode(node: HtmlElement, key: string, depth: number): ReactNode {
    const { tag, attrs, children } = node;
    switch (tag) {
      case "div":
      case "section": {
        const centered = (attrs.align ?? "").toLowerCase() === "center";
        return (
          <View key={key} style={{ gap: BLOCK_GAP, ...(centered ? { alignItems: "center" as const } : {}) }}>
            {renderHtmlBlocks(children, key, depth)}
          </View>
        );
      }
      case "center":
        return (
          <View key={key} style={{ gap: BLOCK_GAP, alignItems: "center" }}>
            {renderHtmlBlocks(children, key, depth)}
          </View>
        );
      case "p":
        return (
          <Text key={key} selectable style={text}>
            {renderHtmlInline(children)}
          </Text>
        );
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return (
          <Text key={key} accessibilityRole="header" style={headingStyle(Number(tag[1]), c)}>
            {renderHtmlInline(children)}
          </Text>
        );
      case "hr":
        return <View key={key} style={{ height: 1, backgroundColor: c.border, marginVertical: 8 }} />;
      case "blockquote":
        return (
          <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 12, gap: 8 }}>
            {renderHtmlBlocks(children, key, depth)}
          </View>
        );
      case "pre": {
        const codeChild = children.find((n): n is HtmlElement => isElement(n) && n.tag === "code");
        const codeText = collectText(codeChild ? codeChild.children : children);
        return (
          <ScrollView key={key} horizontal style={{ backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}>
            <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, lineHeight: 18, padding: 12 }}>
              {decodeEntities(codeText)}
            </Text>
          </ScrollView>
        );
      }
      case "video": {
        const src = findVideoSrc(node);
        if (!src) return null;
        if (Platform.OS === "web") return renderVideoElement({ src });
        if (!/^https:\/\//i.test(src.trim())) return null;
        return (
          <Pressable key={key} accessibilityRole="button" onPress={() => void openExternalUrl(src).catch(() => toast.error("Could not open video."))}>
            <Text style={{ color: c.accent, fontSize: 14 }}>▶ Open video</Text>
          </Pressable>
        );
      }
      case "svg": {
        if (!node.raw) return null;
        if (Platform.OS !== "web") {
          return (
            <View key={key} style={{ height: 80, alignItems: "center", justifyContent: "center", backgroundColor: c.surface1, borderRadius: 6 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>SVG image</Text>
            </View>
          );
        }
        const dims = svgDimensions(attrs);
        const height = Math.min(dims?.height ?? 200, 480);
        const width = dims ? Math.round((dims.width / dims.height) * height) : 320;
        return <Image key={key} source={{ uri: svgDataUri(node.raw) }} resizeMode="contain" style={{ width, height }} />;
      }
      case "ul":
      case "ol": {
        const items = children.filter((n): n is HtmlElement => isElement(n) && n.tag === "li");
        return (
          <View key={key} style={{ gap: 6, paddingLeft: depth > 0 ? 18 : 0 }}>
            {items.map((item, n) => renderHtmlListItem(item, tag === "ol", n, `${key}-li${n}`, depth))}
          </View>
        );
      }
      case "li":
        return renderHtmlListItem(node, false, 0, key, depth);
      case "table":
        return renderHtmlTable(node, key);
      case "details": {
        const summaryNode = children.find((n): n is HtmlElement => isElement(n) && n.tag === "summary");
        const rest = summaryNode ? children.filter((n) => n !== summaryNode) : children;
        return (
          <CollapsibleDetails
            key={key}
            theme={theme}
            defaultOpen={"open" in attrs}
            summary={
              <Text style={{ ...text, fontWeight: "600" }}>{summaryNode ? renderHtmlInline(summaryNode.children) : "Details"}</Text>
            }
          >
            {renderHtmlBlocks(rest, `${key}-body`, depth + 1)}
          </CollapsibleDetails>
        );
      }
      default:
        return (
          <View key={key} style={{ gap: BLOCK_GAP }}>
            {renderHtmlBlocks(children, key, depth)}
          </View>
        );
    }
  }

  /** Renders a flat HtmlNode list, grouping consecutive inline-only nodes into one Text block
   * (so e.g. two pressable images separated by "&nbsp;" flow side by side), and giving a lone
   * image its own full block treatment (measured, capped at 480px, no Text wrapper needed). */
  function renderHtmlBlocks(nodes: HtmlNode[], keyPrefix: string, depth: number): ReactNode[] {
    const out: ReactNode[] = [];
    let runStart = -1;

    function flushRun(end: number) {
      if (runStart === -1) return;
      const run = nodes.slice(runStart, end).filter((n) => !(n.type === "text" && n.text.trim() === ""));
      const start = runStart;
      runStart = -1;
      if (run.length === 0) return;
      if (run.length === 1 && isElement(run[0]!)) {
        const image = resolveBlockImage(run[0] as HtmlElement);
        if (image) {
          out.push(
            <AutoImage
              key={`${keyPrefix}-img${start}`}
              mode="block"
              src={image.src}
              alt={image.alt}
              theme={theme}
              baseUrl={baseUrl}
              explicitWidth={image.width}
              explicitHeight={image.height}
              href={image.href}
            />,
          );
          return;
        }
      }
      out.push(
        <Text key={`${keyPrefix}-run${start}`} selectable style={text}>
          {renderHtmlInline(run)}
        </Text>,
      );
    }

    nodes.forEach((node, idx) => {
      if (!isBlockElement(node)) {
        if (runStart === -1) runStart = idx;
        return;
      }
      flushRun(idx);
      out.push(renderHtmlBlockNode(node, `${keyPrefix}-${idx}`, depth));
    });
    flushRun(nodes.length);
    return out;
  }

  // --- marked-token block rendering ----------------------------------------------------------

  /** Net count of opening-minus-closing `<tag>`s in a raw HTML chunk (handles e.g. nested
   * `<details>` by counting every occurrence, not just the first). */
  function tagBalance(raw: string, tag: string): number {
    const openRe = new RegExp(`<${tag}(?:[\\s/][^>]*)?>`, "gi");
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
    const opens = raw.match(openRe)?.length ?? 0;
    const closes = raw.match(closeRe)?.length ?? 0;
    return opens - closes;
  }

  /** Marked gives us `<details>...<summary>...</summary>` as one html token, the body as
   * ordinary markdown tokens, and `</details>` as a later html token. Detects that an html
   * token opened a `details` (or `div`) container it didn't also close. */
  function detectOpenContainer(raw: string): { tag: "details" | "div"; attrs: Record<string, string>; summary: HtmlNode[] | null } | null {
    let tag: "details" | "div" | null = null;
    if (tagBalance(raw, "details") > 0) tag = "details";
    else if (tagBalance(raw, "div") > 0) tag = "div";
    if (!tag) return null;
    const parsed = parseHtmlFragment(raw);
    const node = [...parsed].reverse().find((n): n is HtmlElement => isElement(n) && n.tag === tag);
    if (!node) return null;
    const summaryNode = tag === "details" ? node.children.find((n): n is HtmlElement => isElement(n) && n.tag === "summary") : undefined;
    return { tag, attrs: node.attrs, summary: summaryNode ? summaryNode.children : null };
  }

  function renderContainer(
    opened: { tag: "details" | "div"; attrs: Record<string, string>; summary: HtmlNode[] | null },
    inner: Token[],
    key: string,
    depth: number,
  ): ReactNode {
    if (opened.tag === "details") {
      return (
        <CollapsibleDetails
          key={key}
          theme={theme}
          defaultOpen={"open" in opened.attrs}
          summary={
            <Text style={{ ...text, fontWeight: "600" }}>{opened.summary ? renderHtmlInline(opened.summary) : "Details"}</Text>
          }
        >
          {blocks(inner, depth + 1)}
        </CollapsibleDetails>
      );
    }
    const centered = (opened.attrs.align ?? "").toLowerCase() === "center";
    return (
      <View key={key} style={{ gap: BLOCK_GAP, ...(centered ? { alignItems: "center" as const } : {}) }}>
        {blocks(inner, depth)}
      </View>
    );
  }

  function renderBlockquote(token: Tokens.Blockquote, key: string, depth: number): ReactNode {
    const children = token.tokens ?? [];
    const firstParagraph = children.find((t): t is Tokens.Paragraph => t.type === "paragraph");
    const firstLine = firstParagraph?.text.split("\n")[0] ?? "";
    const alert = firstParagraph ? detectAlert(firstLine) : null;
    if (alert && firstParagraph) {
      const restLines = firstParagraph.text.split("\n").slice(1);
      const bodyText = [alert.rest, ...restLines].filter((line) => line.length > 0).join("\n");
      const bodyTokens = bodyText.trim() ? marked.lexer(bodyText, { gfm: true, breaks: true }) : [];
      const otherTokens = children.filter((t) => t !== firstParagraph);
      const meta = ALERT_META[alert.kind];
      const color = meta.color(c);
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: color, paddingLeft: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={meta.icon} size={14} color={color} />
            <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{meta.label}</Text>
          </View>
          {blocks([...bodyTokens, ...otherTokens], depth)}
        </View>
      );
    }
    return (
      <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 12, gap: 8 }}>
        {blocks(children, depth)}
      </View>
    );
  }

  function renderBlockToken(token: Token, key: string, depth: number): ReactNode {
    switch (token.type) {
      case "space":
      case "def":
      case "checkbox":
        return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        return (
          <Text key={key} accessibilityRole="header" style={headingStyle(heading.depth, c)}>
            {inline(heading.tokens ?? [])}
          </Text>
        );
      }
      case "paragraph":
      case "text": {
        const withTokens = token as Tokens.Paragraph | Tokens.Text;
        const children = withTokens.tokens ?? [];
        if (children.length === 1 && children[0]!.type === "image") {
          const image = children[0] as Tokens.Image;
          return (
            <AutoImage
              key={key}
              mode="block"
              src={image.href}
              alt={image.text}
              theme={theme}
              baseUrl={baseUrl}
            />
          );
        }
        return (
          <Text key={key} selectable style={text}>
            {children.length ? inline(children) : withTokens.text}
          </Text>
        );
      }
      case "code": {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? "").trim().toLowerCase();
        if (lang === "mermaid" || lang.startsWith("mermaid ")) {
          return <MermaidView key={key} source={codeToken.text} theme={theme} />;
        }
        return (
          <View key={key} style={{ backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}>
            {codeToken.lang ? (
              <Text style={{ position: "absolute", top: 4, right: 8, color: c.foregroundMuted, fontSize: 10 }}>{codeToken.lang}</Text>
            ) : null}
            <ScrollView horizontal>
              <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, lineHeight: 18, padding: 12 }}>
                {codeToken.text}
              </Text>
            </ScrollView>
          </View>
        );
      }
      case "list": {
        const listToken = token as Tokens.List;
        const startNum = Number(listToken.start) || 1;
        return (
          <View key={key} style={{ gap: 6, paddingLeft: depth > 0 ? 18 : 0 }}>
            {listToken.items.map((item, n) => (
              <View key={n} style={{ flexDirection: "row", gap: 10 }}>
                {item.task ? (
                  <Icon name={item.checked ? "SquareCheck" : "Square"} size={13} color={c.foregroundMuted} />
                ) : (
                  <Text style={{ ...text, color: c.foregroundMuted, width: 20 }}>
                    {listToken.ordered ? `${startNum + n}.` : "•"}
                  </Text>
                )}
                <View style={{ flex: 1, gap: 6 }}>{blocks(item.tokens, depth + 1)}</View>
              </View>
            ))}
          </View>
        );
      }
      case "blockquote":
        return renderBlockquote(token as Tokens.Blockquote, key, depth);
      case "hr":
        return <View key={key} style={{ height: 1, backgroundColor: c.border, marginVertical: 8 }} />;
      case "table": {
        const tableToken = token as Tokens.Table;
        const header = tableToken.header.map((cell, ci) => ({ node: <Fragment key={ci}>{inline(cell.tokens)}</Fragment>, text: cell.text }));
        const rows = tableToken.rows.map((row) => row.map((cell, ci) => ({ node: <Fragment key={ci}>{inline(cell.tokens)}</Fragment>, text: cell.text })));
        return renderTableGrid(c, header, rows, key);
      }
      default:
        if ("raw" in token) {
          return (
            <Text key={key} selectable style={text}>
              {decodeEntities(token.raw)}
            </Text>
          );
        }
        return null;
    }
  }

  function blocks(items: Token[], depth = 0): ReactNode[] {
    const out: ReactNode[] = [];
    let i = 0;
    while (i < items.length) {
      const token = items[i]!;
      const key = `b${depth}-${i}`;

      if (token.type === "html" && (token as Tokens.HTML).block) {
        const htmlToken = token as Tokens.HTML;
        const opened = detectOpenContainer(htmlToken.text);
        if (opened) {
          let remaining = 1;
          const inner: Token[] = [];
          let j = i + 1;
          while (j < items.length) {
            const next = items[j]!;
            if (next.type === "html" && (next as Tokens.HTML).block) {
              remaining += tagBalance((next as Tokens.HTML).text, opened.tag);
              if (remaining <= 0) {
                j++;
                break;
              }
            }
            inner.push(next);
            j++;
          }
          out.push(renderContainer(opened, inner, key, depth));
          i = j;
          continue;
        }
        out.push(...renderHtmlBlocks(parseHtmlFragment(htmlToken.text), key, depth));
        i++;
        continue;
      }

      out.push(renderBlockToken(token, key, depth));
      i++;
    }
    return out;
  }

  // `blocks`/`inline` are cheap closures, but walking a large token tree into React elements
  // is not: memoize the walk itself so an unrelated parent re-render (e.g. a toast, or toggling
  // "show markdown") doesn't re-walk a very long PR body every time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const content = useMemo(() => blocks(tokens), [tokens, c, baseUrl]);

  return <View style={{ gap: BLOCK_GAP }}>{content}</View>;
}
