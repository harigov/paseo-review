import { describe, expect, it } from "vitest";
import { decodeEntities, parseHtmlFragment } from "../client/render/html-subset";

describe("parseHtmlFragment", () => {
  it("parses nested elements with text content", () => {
    const tree = parseHtmlFragment("<div><p>hello <b>world</b></p></div>");
    expect(tree).toEqual([
      {
        type: "element",
        tag: "div",
        attrs: {},
        children: [
          {
            type: "element",
            tag: "p",
            attrs: {},
            children: [
              { type: "text", text: "hello " },
              { type: "element", tag: "b", attrs: {}, children: [{ type: "text", text: "world" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("drops HTML comments entirely, merging surrounding text", () => {
    const tree = parseHtmlFragment("a<!-- comment -->b");
    expect(tree).toEqual([{ type: "text", text: "ab" }]);
  });

  it("drops a multi-line comment", () => {
    const tree = parseHtmlFragment("<p>x</p><!--\nmulti\nline\n--><p>y</p>");
    expect(tree).toEqual([
      { type: "element", tag: "p", attrs: {}, children: [{ type: "text", text: "x" }] },
      { type: "element", tag: "p", attrs: {}, children: [{ type: "text", text: "y" }] },
    ]);
  });

  it("never gives void elements children, and treats self-closing tags the same way", () => {
    const tree = parseHtmlFragment('<div>before<img src="a.png">after<br/>end</div>');
    expect(tree).toEqual([
      {
        type: "element",
        tag: "div",
        attrs: {},
        children: [
          { type: "text", text: "before" },
          { type: "element", tag: "img", attrs: { src: "a.png" }, children: [] },
          { type: "text", text: "after" },
          { type: "element", tag: "br", attrs: {}, children: [] },
          { type: "text", text: "end" },
        ],
      },
    ]);
  });

  it("implicitly closes unclosed tags at the end of input", () => {
    const tree = parseHtmlFragment("<details>\n<summary>Title</summary>");
    expect(tree).toEqual([
      {
        type: "element",
        tag: "details",
        attrs: {},
        children: [
          { type: "text", text: "\n" },
          { type: "element", tag: "summary", attrs: {}, children: [{ type: "text", text: "Title" }] },
        ],
      },
    ]);
  });

  it("closes an unclosed child implicitly when its parent closes", () => {
    const tree = parseHtmlFragment("<div><span>oops</div>");
    expect(tree).toEqual([
      {
        type: "element",
        tag: "div",
        attrs: {},
        children: [{ type: "element", tag: "span", attrs: {}, children: [{ type: "text", text: "oops" }] }],
      },
    ]);
  });

  it("ignores a stray closing tag with no matching ancestor", () => {
    const tree = parseHtmlFragment("hello</b> world");
    expect(tree).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("parses double-quoted, single-quoted, and unquoted attribute values", () => {
    const tree = parseHtmlFragment(`<a href="https://a.com" title='hi there' data-x=42>t</a>`);
    expect(tree).toEqual([
      {
        type: "element",
        tag: "a",
        attrs: { href: "https://a.com", title: "hi there", "data-x": "42" },
        children: [{ type: "text", text: "t" }],
      },
    ]);
  });

  it("handles a boolean attribute with no value", () => {
    const tree = parseHtmlFragment("<details open><summary>s</summary></details>");
    expect((tree[0] as { attrs: Record<string, string> }).attrs).toEqual({ open: "" });
  });

  it("lower-cases tag names", () => {
    const tree = parseHtmlFragment("<DIV><SPAN>x</SPAN></DIV>");
    expect(tree[0]).toMatchObject({ tag: "div" });
    expect((tree[0] as { children: unknown[] }).children[0]).toMatchObject({ tag: "span" });
  });

  it("drops script and style elements along with their raw content", () => {
    const tree = parseHtmlFragment('<p>a</p><script>if (1 < 2) { alert("<p>nope</p>"); }</script><style>.x{color:red}</style><p>b</p>');
    expect(tree).toEqual([
      { type: "element", tag: "p", attrs: {}, children: [{ type: "text", text: "a" }] },
      { type: "element", tag: "p", attrs: {}, children: [{ type: "text", text: "b" }] },
    ]);
  });

  it("parses the real Cursor Bugbot fix-in-cursor div without losing structure", () => {
    const html =
      '<div><a href="https://cursor.com/open?link=abc" target="_blank" rel="noopener noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img alt="Fix in Cursor" width="115" height="28" src="dark.png"></picture></a>&nbsp;<a href="https://cursor.com/agents?link=def"><picture><img alt="Fix in Web" width="99" height="28" src="web.png"></picture></a></div>';
    const tree = parseHtmlFragment(html);
    expect(tree).toHaveLength(1);
    const div = tree[0] as { tag: string; children: unknown[] };
    expect(div.tag).toBe("div");
    expect(div.children).toHaveLength(3); // <a>, "&nbsp;" text, <a>
    const firstLink = div.children[0] as { tag: string; attrs: Record<string, string>; children: { tag: string }[] };
    expect(firstLink.tag).toBe("a");
    expect(firstLink.attrs.href).toBe("https://cursor.com/open?link=abc");
    const picture = firstLink.children[0] as { tag: string; children: { tag: string; attrs: Record<string, string> }[] };
    expect(picture.tag).toBe("picture");
    const img = picture.children.find((c) => c.tag === "img")!;
    expect(img.attrs).toMatchObject({ width: "115", height: "28" });
    expect(div.children[1]).toEqual({ type: "text", text: "&nbsp;" });
  });
});

describe("decodeEntities", () => {
  it("decodes the common named entities", () => {
    expect(decodeEntities("&amp; &lt; &gt; &quot; &apos; &nbsp;")).toBe('& < > " \'  ');
    expect(decodeEntities("&copy; &reg; &hellip; &mdash; &ndash; &laquo; &raquo; &times;")).toBe(
      "© ® … — – « » ×",
    );
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeEntities("&#39;")).toBe("'");
    expect(decodeEntities("&#x27;")).toBe("'");
    expect(decodeEntities("&#X27;")).toBe("'");
  });

  it("leaves unknown entities and plain text untouched", () => {
    expect(decodeEntities("a &foobar; b")).toBe("a &foobar; b");
    expect(decodeEntities("plain text")).toBe("plain text");
  });

  it("is a no-op when there is no ampersand", () => {
    expect(decodeEntities("nothing to decode")).toBe("nothing to decode");
  });
});
