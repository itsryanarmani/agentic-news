import { describe, expect, test } from "vitest";
import { dedupe } from "../src/dedupe.js";
import { discover } from "../src/discover.js";
import { filterItems } from "../src/filter.js";
import { fixtureConfig, fixtureWeb, NOW } from "./helpers.js";

// Runs the real discover -> filter -> dedupe stages on the fixture feeds.
// Each case maps to a row in docs/failure-modes.md.
async function run(seen: Set<string> = new Set(), overrides: Record<string, unknown> = {}) {
  const config = fixtureConfig(overrides);
  const web = fixtureWeb();
  const found = await discover(config, web.fetch);
  const filtered = filterItems(found.items, config, NOW);
  const deduped = dedupe(filtered.kept, seen);
  const reasons = [...filtered.rejected, ...deduped.rejected].map((r) => `${r.reason} ${r.url}`);
  return { filtered, deduped, reasons, web };
}

describe("filter and dedupe on fixture feeds", () => {
  test("F5-F8: off-topic, stale, undated, blocked and off-list items are rejected with reasons", async () => {
    const { reasons } = await run();
    expect(reasons).toEqual(expect.arrayContaining([
      "off_topic https://news.example.test/2026/11/bakery",
      "stale https://news.example.test/2024/01/rebate-program",
      "blocked_domain https://blocked.example.test/rebate-scam",
      "host_not_allowed https://partner.example.test/guide",
      "no_date https://news.example.test/2026/11/deadline",
    ]));
  });

  test("F3 and F4: the same story across feeds is kept once", async () => {
    const { deduped, reasons } = await run();
    expect(reasons).toContain("duplicate_url https://news.example.test/2026/11/heat-pump-rebate-renters/");
    expect(reasons).toContain("near_duplicate_title https://agency.example.test/notices/rebate-renters");
    expect(deduped.kept.map((i) => i.canonicalUrl)).toEqual([
      "https://news.example.test/2026/11/heat-pump-rebate-renters",
      "https://news.example.test/2026/11/installer-backlog",
      "https://news.example.test/2026/11/members-only",
      "https://agency.example.test/notices/efficiency-standard",
    ]);
    expect(deduped.kept[0].matched).toEqual(["heat pump", "rebate"]);
  });

  test("F18 (first half): an item already in the state store is not processed again", async () => {
    const first = await run();
    const again = await run(new Set([first.deduped.kept[0].key]));
    expect(again.reasons).toContain("already_processed https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss");
    // Its copy under another URL in another feed must not slip through on the retry.
    expect(again.reasons).toContain("duplicate_content https://agency.example.test/notices/rebate-renters");
  });

  test("a blocked domain wins over the allow-list", async () => {
    const { reasons } = await run(new Set(), { blockedDomains: ["agency.example.test", "blocked.example.test"] });
    expect(reasons).toContain("blocked_domain https://agency.example.test/notices/efficiency-standard");
  });

  test("a narrower recency window drops yesterday's notice", async () => {
    const { reasons } = await run(new Set(), { recencyHours: 12 });
    expect(reasons).toContain("stale https://agency.example.test/notices/efficiency-standard");
  });
});
