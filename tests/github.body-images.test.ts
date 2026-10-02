import { describe, expect, it } from "vitest";
import { inlineRepoImages, inlineRepoImagesWith, type FetchBytes } from "../server/github/body-images";

const REPO = "acme/widgets";

function pngBytes(size = 16): Buffer {
  return Buffer.alloc(size, 1);
}

/** A fetcher that resolves from a fixed map of "owner/name#ref#path" -> bytes (or throws/nulls
 * for anything else), and records every call it received. */
function fakeFetcher(entries: Record<string, Buffer | null>): FetchBytes & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (owner: string, name: string, ref: string, path: string) => {
    const key = `${owner}/${name}#${ref}#${path}`;
    calls.push(key);
    return key in entries ? entries[key] : null;
  }) as FetchBytes & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("inlineRepoImagesWith: URL matching", () => {
  it("rewrites a github.com blob URL for this repo", async () => {
    const html = `<p><img src="https://github.com/acme/widgets/blob/main/docs/diagram.png" alt="x"></p>`;
    const fetcher = fakeFetcher({ "acme/widgets#main#docs/diagram.png": pngBytes() });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toContain(`src="data:image/png;base64,${pngBytes().toString("base64")}"`);
    expect(out).not.toContain("github.com/acme/widgets/blob");
    expect(out).toContain('alt="x"'); // other attributes survive
  });

  it("rewrites a github.com raw URL, case-insensitively on owner/repo", async () => {
    const html = `<img src="https://github.com/ACME/Widgets/raw/main/a.gif">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#a.gif": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toContain("data:image/gif;base64,");
  });

  it("rewrites a root-relative blob/raw URL", async () => {
    const html = `<img src="/acme/widgets/blob/main/img.webp">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#img.webp": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toContain("data:image/webp;base64,");
  });

  it("rewrites a raw.githubusercontent.com URL", async () => {
    const html = `<img src="https://raw.githubusercontent.com/acme/widgets/main/assets/x.svg">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#assets/x.svg": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toContain("data:image/svg+xml;base64,");
  });

  it("ignores a ?raw=true query suffix when matching", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/a.png?raw=true">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#a.png": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toContain("data:image/png;base64,");
  });
});

describe("inlineRepoImagesWith: entity decoding", () => {
  it("HTML-entity-decodes the src attribute before matching and fetching", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/docs/a&amp;b.png">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#docs/a&b.png": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual(["acme/widgets#main#docs/a&b.png"]);
    expect(out).toContain("data:image/png;base64,");
  });
});

describe("inlineRepoImagesWith: split-point retries", () => {
  it("tries ref = first 1, then 2 segments when the branch name contains a slash", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/release/2.0/assets/logo.png">`;
    // Only the 2-segment ref is "real"; the 1-segment attempt must fail first.
    const fetcher = fakeFetcher({ "acme/widgets#release/2.0#assets/logo.png": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual([
      "acme/widgets#release#2.0/assets/logo.png",
      "acme/widgets#release/2.0#assets/logo.png",
    ]);
    expect(out).toContain("data:image/png;base64,");
  });

  it("stops at the first split point that resolves and does not try a third", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/a/b/c/d.png">`;
    const fetcher = fakeFetcher({ "acme/widgets#a#b/c/d.png": pngBytes(4) });
    await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual(["acme/widgets#a#b/c/d.png"]);
  });

  it("gives up after 3 split points and leaves the original src", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/a/b/c/d/e.png">`;
    const fetcher = fakeFetcher({});
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual([
      "acme/widgets#a#b/c/d/e.png",
      "acme/widgets#a/b#c/d/e.png",
      "acme/widgets#a/b/c#d/e.png",
    ]);
    expect(out).toBe(html);
  });
});

describe("inlineRepoImagesWith: caps", () => {
  it("only inlines the first 20 images, leaving the rest untouched", async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `<img src="https://github.com/acme/widgets/blob/main/f${i}.png">`);
    const html = tags.join("\n");
    const entries: Record<string, Buffer> = {};
    for (let i = 0; i < 25; i += 1) entries[`acme/widgets#main#f${i}.png`] = pngBytes(4);
    const fetcher = fakeFetcher(entries);
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect((out.match(/data:image\/png/g) ?? []).length).toBe(20);
    for (let i = 20; i < 25; i += 1) {
      expect(out).toContain(`src="https://github.com/acme/widgets/blob/main/f${i}.png"`);
    }
  });

  it("leaves an over-5MB image as the original URL", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/big.png">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#big.png": Buffer.alloc(6 * 1024 * 1024) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toBe(html);
  });

  it("caps the total across a body at ~20MB even when every image is individually under the per-image cap", async () => {
    // 5 images at exactly the 5MB per-image cap: whichever 4 are checked first push the running
    // total to 0/5/10/15 MB (all <= 20MB, so all 4 succeed); whichever is checked last always
    // sees total 20MB and 20+5 > 20, so it's rejected — deterministic regardless of scheduling.
    const names = ["a", "b", "c", "d", "e"];
    const html = names.map((n) => `<img src="https://github.com/acme/widgets/blob/main/${n}.png">`).join("\n");
    const entries: Record<string, Buffer> = {};
    for (const n of names) entries[`acme/widgets#main#${n}.png`] = Buffer.alloc(5 * 1024 * 1024);
    const fetcher = fakeFetcher(entries);
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect((out.match(/data:image\/png/g) ?? []).length).toBe(4);
    const remainingOriginals = names.filter((n) => out.includes(`src="https://github.com/acme/widgets/blob/main/${n}.png"`));
    expect(remainingOriginals).toHaveLength(1);
  });
});

describe("inlineRepoImagesWith: other-repo URLs and unsupported extensions", () => {
  it("leaves a different repo's image untouched and never calls the fetcher for it", async () => {
    const html = `<img src="https://github.com/other/repo/blob/main/x.png">`;
    const fetcher = fakeFetcher({});
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toBe(html);
    expect(fetcher.calls).toEqual([]);
  });

  it("leaves a plain external image URL untouched", async () => {
    const html = `<img src="https://example.com/picture.png">`;
    const fetcher = fakeFetcher({});
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toBe(html);
  });

  it("skips an unsupported extension without fetching it", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/spec.pdf">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#spec.pdf": pngBytes(4) });
    const out = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(out).toBe(html);
    expect(fetcher.calls).toEqual([]);
  });
});

describe("inlineRepoImagesWith: failure passthrough and caching", () => {
  it("leaves the src unchanged and never throws when the fetcher returns null", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/missing.png">`;
    const fetcher = fakeFetcher({});
    await expect(inlineRepoImagesWith(html, REPO, fetcher)).resolves.toBe(html);
  });

  it("leaves the src unchanged and never throws when the fetcher rejects", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/boom.png">`;
    const throwing: FetchBytes = async () => {
      throw new Error("network exploded");
    };
    await expect(inlineRepoImagesWith(html, REPO, throwing)).resolves.toBe(html);
  });

  it("never throws on malformed html or a repo slug with no owner/name shape", async () => {
    const fetcher = fakeFetcher({});
    await expect(inlineRepoImagesWith("<img src=", REPO, fetcher)).resolves.toBe("<img src=");
    await expect(inlineRepoImagesWith("<img src='unterminated>", "not-a-slug", fetcher)).resolves.toBe("<img src='unterminated>");
  });

  it("caches a miss briefly so the same missing image isn't refetched on a second load", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/cached-miss.png">`;
    const fetcher = fakeFetcher({});
    await inlineRepoImagesWith(html, REPO, fetcher);
    await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual(["acme/widgets#main#cached-miss.png"]); // not called a 2nd time
  });

  it("caches a hit so the same image isn't refetched on a second load", async () => {
    const html = `<img src="https://github.com/acme/widgets/blob/main/cached-hit.png">`;
    const fetcher = fakeFetcher({ "acme/widgets#main#cached-hit.png": pngBytes(4) });
    const out1 = await inlineRepoImagesWith(html, REPO, fetcher);
    const out2 = await inlineRepoImagesWith(html, REPO, fetcher);
    expect(fetcher.calls).toEqual(["acme/widgets#main#cached-hit.png"]);
    expect(out1).toBe(out2);
  });
});

describe("inlineRepoImages", () => {
  it("is exported with the default gh-backed fetcher and never throws on bodies with no matching images", async () => {
    await expect(inlineRepoImages("<p>no images here</p>", REPO)).resolves.toBe("<p>no images here</p>");
  });
});
