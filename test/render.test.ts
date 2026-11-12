import { describe, expect, test } from "vitest";
import { checkAttribution, slugify } from "../src/render.js";
import { fixtureConfig, renderFirst } from "./helpers.js";

const config = fixtureConfig();

describe("render", () => {
  test("markdown has front matter, the TL;DR first, context, and the source link", async () => {
    const rendered = await renderFirst();
    const lines = rendered.markdown.split("\n");
    expect(lines.slice(0, 2)).toEqual(["---", 'title: "Province expands heat pump rebate to renters"']);
    expect(rendered.markdown).toContain('source_url: "https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss"');
    expect(rendered.markdown).toContain('tags: ["heat-pumps","heat-pump","rebate"]');
    const body = rendered.markdown.split("---\n").at(-1) ?? "";
    expect(body.trimStart().startsWith("**TL;DR:** Example News reports:")).toBe(true);
    expect(body).toContain("## Why it matters");
    expect(body).toContain("Related: [How rebates work](https://directory.example.test/guides/rebates)");
    expect(body).toContain("Source: [Example News](https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss), published 2026-11-12.");
    expect(rendered.data).toMatchObject({ slug: expect.stringMatching(/^2026-11-12-province-expands-heat-pump-rebate-to-renters-[0-9a-f]{16}$/), postKey: expect.stringMatching(/^example-niche:[0-9a-f]{16}$/) });
    expect(checkAttribution(rendered, config)).toEqual([]);
  });

  test("an article without a source name or with a link off the allow-list is refused", async () => {
    const rendered = await renderFirst();
    const unnamed = { ...rendered, data: { ...rendered.data, source_name: "" } };
    expect(checkAttribution(unnamed, config).map((f) => f.reason)).toEqual(["missing_attribution", "missing_source_link"]);
    const offList = { ...rendered, data: { ...rendered.data, source_url: "https://elsewhere.example.test/x" } };
    expect(checkAttribution(offList, config).map((f) => f.reason)).toEqual(["source_link_not_allowed", "missing_source_link"]);
  });

  test("summary text cannot inject HTML into the page", async () => {
    const rendered = await renderFirst();
    const evil = renderArticle(
      { key: "abcdef0123456789", url: rendered.data.source_url, title: "T", sourceName: "Example <b>News</b>", text: "" },
      { tldr: "It works <script>alert(1)</script>.", whyItMatters: "<img src=x onerror=alert(1)>" },
      config, [], NOW,
    );
    // Front matter and JSON carry raw data for templates; the markdown body is escaped.
    const body = evil.markdown.split("---\n").at(-1) ?? "";
    expect(body).not.toMatch(/<script|<img|<b>/);
    expect(evil.markdown).toContain("It works &lt;script&gt;alert(1)&lt;/script&gt;.");
    expect(evil.data.slug).toBe("2026-11-12-t-abcdef0123456789");
    const fenced = renderArticle(
      { key: "abcdef0123456789", url: rendered.data.source_url, title: "T", sourceName: "Example News", text: "" },
      { tldr: "It works.\n\n```", whyItMatters: "~~~" }, config, [], NOW,
    );
    expect(fenced.markdown.split("\n").some((line) => /^(```|~~~)/.test(line))).toBe(false);
    expect(checkAttribution(fenced, config)).toEqual([]);
  });

  test("parentheses in a source URL cannot cut the link short", async () => {
    const rendered = await renderFirst();
    const odd = renderArticle(
      { key: "abcdef0123456789", url: "https://news.example.test/a)b", title: "T", sourceName: "Example News", text: "" },
      { tldr: "It works.", whyItMatters: "" }, config, [], NOW,
    );
    expect(odd.markdown).toContain("[Example News](https://news.example.test/a%29b)");
    expect(checkAttribution(odd, config)).toEqual([]);
    const nbsp = renderArticle(
      { key: "abcdef0123456789", url: "https://news.example.test/a\u00a0b", title: "T", sourceName: "Example News", text: "" },
      { tldr: "It works.", whyItMatters: "" }, config, [], NOW,
    );
    expect(nbsp.markdown).toContain("(https://news.example.test/a%C2%A0b)");
    void rendered;
  });

  test("slugs are short, ASCII and cut on a word break", () => {
    expect(slugify("Café rebate: what renters need to know about the new provincial heat pump program")).toBe("cafe-rebate-what-renters-need-to-know-about-the-new");
  });
});
