import { describe, expect, test } from "vitest";
import { extractText, fetchArticle, parseRobots, robotsAllows } from "../src/article.js";
import { dedupe } from "../src/dedupe.js";
import { discover } from "../src/discover.js";
import { filterItems } from "../src/filter.js";
import type { FixtureRoute } from "../src/fixture-fetch.js";
import { fixtureConfig, fixtureWeb, NOW } from "./helpers.js";

// Runs discover -> filter -> dedupe -> fetch on the fixture web.
async function fetchAll(extra: Record<string, FixtureRoute> = {}) {
  const config = fixtureConfig();
  const web = fixtureWeb(extra);
  const { items } = await discover(config, web.fetch);
  const { kept } = dedupe(filterItems(items, config, NOW).kept);
  const robots = new Map();
  const results = await Promise.all(kept.map((item) =>
    fetchArticle(item, config, { fetch: web.fetch, robots }).then(
      (article) => ({ url: item.canonicalUrl, article, reason: undefined as string | undefined }),
      (error: { reason?: string }) => ({ url: item.canonicalUrl, article: undefined, reason: error.reason }),
    )));
  return { results, web };
}

describe("safe article fetch", () => {
  test("a good article comes back as clean text without scripts or page chrome", async () => {
    const { results } = await fetchAll();
    const text = results[0].article?.text ?? "";
    expect(text).toContain("The rebate covers up to $5,000");
    expect(text).not.toMatch(/track|tracking pixel|Subscribe|Copyright/);
    expect(results[3].article?.text).toContain("312 submissions");
  });

  test("F9: a redirect off the allow-list is refused and the new host is never requested", async () => {
    const { results, web } = await fetchAll();
    expect(results[1].reason).toBe("redirect_off_allow_list");
    expect(web.requests.some((u) => u.includes("elsewhere.example.test"))).toBe(false);
  });

  test("F11: a paywall page is refused", async () => {
    const { results } = await fetchAll();
    expect(results[2].reason).toBe("paywall");
  });

  test("F11: a login page is refused", async () => {
    const { results } = await fetchAll({
      "https://agency.example.test/notices/efficiency-standard": { body: "<form><input type=\"password\"></form>", headers: { "content-type": "text/html" } },
    });
    expect(results[3].reason).toBe("login_required");
  });

  test("F10: robots.txt that disallows the path stops the fetch before the page is requested", async () => {
    const { results, web } = await fetchAll({
      "https://agency.example.test/robots.txt": { body: "User-agent: *\nDisallow: /notices/\n" },
    });
    expect(results[3].reason).toBe("robots_disallowed");
    expect(web.requests).not.toContain("https://agency.example.test/notices/efficiency-standard");
  });

  test("a robots.txt that fails with 5xx means stay out", async () => {
    const config = fixtureConfig();
    const { items } = await discover(config, fixtureWeb().fetch);
    const item = dedupe(filterItems(items, config, NOW).kept).kept[3];
    const web = fixtureWeb({ "https://agency.example.test/robots.txt": { status: 503 } });
    await expect(fetchArticle(item, config, { fetch: web.fetch })).rejects.toMatchObject({ reason: "robots_unavailable" });
    expect(web.requests).not.toContain(item.url);
  });

  test("F12: an oversized article is refused", async () => {
    const { results } = await fetchAll({
      "https://agency.example.test/notices/efficiency-standard": { body: `<p>${"heat pump ".repeat(200_000)}</p>`, headers: { "content-type": "text/html" } },
    });
    expect(results[3].reason).toBe("too_large");
  });

  test("robots.txt applies to feeds too", async () => {
    const web = fixtureWeb({ "https://agency.example.test/robots.txt": { body: "User-agent: *\nDisallow: /\n" } });
    const found = await discover(fixtureConfig(), web.fetch);
    expect(found.errors.find((e) => e.source === "Example Agency")?.reason).toBe("robots_disallowed");
    expect(web.requests).not.toContain("https://agency.example.test/atom.xml");
  });

  test("a redirect to a blocked subdomain is refused", async () => {
    const config = fixtureConfig({ fetchAllowList: ["*.news.example.test", "agency.example.test"], blockedDomains: ["bad.news.example.test"] });
    const web = fixtureWeb({ "https://agency.example.test/notices/efficiency-standard": { status: 302, headers: { location: "https://bad.news.example.test/x" } } });
    const { items } = await discover(config, web.fetch);
    const item = dedupe(filterItems(items, config, NOW).kept).kept.find((i) => i.url.includes("efficiency"));
    await expect(fetchArticle(item!, config, { fetch: web.fetch })).rejects.toMatchObject({ reason: "redirect_off_allow_list" });
    expect(web.requests.some((u) => u.includes("bad.news"))).toBe(false);
  });

  test("scripts with spaced or missing close tags and unquoted password inputs are handled", async () => {
    expect(extractText("<article><p>real</p><script><p>fake content</p></script ><p>also real</p></article>")).toBe("real\n\nalso real");
    expect(extractText("<body><p>real</p><script>var x = '<p>fake</p>';")).toBe("real");
    const { results } = await fetchAll({
      "https://agency.example.test/notices/efficiency-standard": { body: `<form-like><input type=password></form-like><p>${"heat pump ".repeat(60)}</p>`, headers: { "content-type": "text/html" } },
    });
    expect(results[3].reason).toBe("login_required");
  });

  test("robots.txt matches decoded paths, and unquoted paywall classes are caught", async () => {
    const config = fixtureConfig();
    const { items } = await discover(config, fixtureWeb().fetch);
    const item = dedupe(filterItems(items, config, NOW).kept).kept[3];
    const encoded = { ...item, url: "https://agency.example.test/%6Eotices/efficiency-standard" };
    const web = fixtureWeb({ "https://agency.example.test/robots.txt": { body: "User-agent: *\nDisallow: /notices/\n" } });
    await expect(fetchArticle(encoded, config, { fetch: web.fetch })).rejects.toMatchObject({ reason: "robots_disallowed" });
    const { results } = await fetchAll({
      "https://agency.example.test/notices/efficiency-standard": { body: `<div class=paywall><p>${"Subscribe now ".repeat(40)}</p></div>`, headers: { "content-type": "text/html" } },
    });
    expect(results[3].reason).toBe("paywall");
  });

  test("robots rules and paths compare decoded", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /caf%C3%A9\n", "agentic-news");
    expect(robotsAllows(rules, "/café")).toBe(false);
  });

  test("an encoded asterisk in a robots rule stays literal", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/%2A/public\n", "agentic-news");
    expect(robotsAllows(rules, "/private/secret/public")).toBe(false);
  });

  test("a literal asterisk in a request path matches an encoded one in a rule", async () => {
    const config = fixtureConfig();
    const { items } = await discover(config, fixtureWeb().fetch);
    const item = dedupe(filterItems(items, config, NOW).kept).kept[3];
    const starred = { ...item, url: "https://agency.example.test/private/*/public" };
    const web = fixtureWeb({ "https://agency.example.test/robots.txt": { body: "User-agent: *\nDisallow: /private/%2A/public\n" } });
    await expect(fetchArticle(starred, config, { fetch: web.fetch })).rejects.toMatchObject({ reason: "robots_disallowed" });
  });

  test("robots rules: own agent group wins, longest match wins", () => {
    const merged = parseRobots("User-agent: agentic-news\nDisallow: /private\n\nUser-agent: agentic-news\nDisallow: /secret\n", "agentic-news");
    expect(robotsAllows(merged, "/secret/x")).toBe(false);
    expect(robotsAllows(merged, "/private")).toBe(false);
    const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: agentic-news\nDisallow: /a/\nAllow: /a/public\n", "agentic-news");
    expect(robotsAllows(rules, "/b")).toBe(true);
    expect(robotsAllows(rules, "/a/x")).toBe(false);
    expect(robotsAllows(rules, "/a/public/1")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /*.pdf$\n", "x"), "/f.pdf")).toBe(false);
  });
});
