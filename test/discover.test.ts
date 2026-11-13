import { describe, expect, test } from "vitest";
import { discover } from "../src/discover.js";
import { parseFeed } from "../src/feed.js";
import { boundedGet } from "../src/http.js";
import { fixtureFetch } from "../src/fixture-fetch.js";
import { fixtureConfig, fixtureWeb } from "./helpers.js";

// Runs discovery on the fixture feeds. Rows refer to docs/failure-modes.md.
describe("discover from allow-listed feeds", () => {
  test("F1 and F2: a down feed and a malformed feed are reported, the run goes on", async () => {
    const found = await discover(fixtureConfig(), fixtureWeb().fetch);
    expect(found.errors.map((e) => [e.source, e.reason])).toEqual([
      ["Down Feed", "network_error"],
      ["Broken Feed", "malformed_feed"],
    ]);
    expect(found.items).toHaveLength(11);
  });

  test("RSS and Atom entries become items with canonical URLs and ISO dates", async () => {
    const { items } = await discover(fixtureConfig(), fixtureWeb().fetch);
    expect(items[0]).toMatchObject({
      title: "Province expands heat pump rebate to renters",
      canonicalUrl: "https://news.example.test/2026/11/heat-pump-rebate-renters",
      publishedAt: "2026-11-12T08:00:00.000Z",
      sourceName: "Example News",
    });
    const atomCopy = items.find((i) => i.sourceName === "Example Agency");
    expect(atomCopy?.key).toBe(items[0].key);
  });

  test("a feed that returns 5xx is a source error", async () => {
    const found = await discover(fixtureConfig(), fixtureWeb({ "https://news.example.test/feed.xml": { status: 503 } }).fetch);
    expect(found.errors[0]).toMatchObject({ source: "Example News", reason: "source_down" });
  });

  test("a feed redirect to another host is refused before that host is contacted", async () => {
    const web = fixtureWeb({
      "https://news.example.test/feed.xml": { status: 302, headers: { location: "https://evil.example.test/feed.xml" } },
    });
    const found = await discover(fixtureConfig(), web.fetch);
    expect(found.errors[0]).toMatchObject({ reason: "redirect_off_allow_list" });
    expect(web.requests).not.toContain("https://evil.example.test/feed.xml");
  });

  test("F12: an oversized body and a timeout are capped", async () => {
    const web = fixtureFetch({
      "https://a.example.test/big": { body: "x".repeat(2048) },
      "https://a.example.test/slow": { error: "timeout" },
    });
    const opts = { fetch: web.fetch, allowHosts: ["a.example.test"], maxBytes: 1024, timeoutMs: 50, userAgent: "test" };
    await expect(boundedGet("https://a.example.test/big", opts)).rejects.toMatchObject({ reason: "too_large" });
    await expect(boundedGet("https://a.example.test/slow", opts)).rejects.toMatchObject({ reason: "timeout" });
  });

  test("allow-list match is exact unless written as *.domain; a redirect to a subdomain is refused", async () => {
    const web = fixtureFetch({
      "https://a.example.test/r": { status: 302, headers: { location: "https://evil.a.example.test/x" } },
      "https://evil.a.example.test/x": { body: "x" },
    });
    const opts = { fetch: web.fetch, maxBytes: 1024, timeoutMs: 50, userAgent: "test" };
    await expect(boundedGet("https://a.example.test/r", { ...opts, allowHosts: ["a.example.test"] }))
      .rejects.toMatchObject({ reason: "redirect_off_allow_list" });
    expect(web.requests).not.toContain("https://evil.a.example.test/x");
    await expect(boundedGet("https://a.example.test/r", { ...opts, allowHosts: ["*.a.example.test"], blockHosts: ["evil.a.example.test"] }))
      .rejects.toMatchObject({ reason: "redirect_off_allow_list" });
    expect((await boundedGet("https://a.example.test/r", { ...opts, allowHosts: ["*.a.example.test"] })).body).toBe("x");
  });

  test("a body that stalls after the headers is a timeout, not a crash", async () => {
    const stalled = new ReadableStream({
      pull(controller) { controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })); },
    });
    const fetch = async () => new Response(stalled);
    await expect(boundedGet("https://a.example.test/s", { fetch, allowHosts: ["a.example.test"], maxBytes: 1024, timeoutMs: 50, userAgent: "t" }))
      .rejects.toMatchObject({ reason: "timeout" });
  });

  test("entities and CDATA decode in feed text", () => {
    const xml = `<rss><channel><item><title><![CDATA[Rebate &amp; heat pump]]></title><link>https://a.example.test/x</link></item></channel></rss>`;
    expect(parseFeed(xml, "https://a.example.test/feed")[0].title).toBe("Rebate & heat pump");
  });
});
