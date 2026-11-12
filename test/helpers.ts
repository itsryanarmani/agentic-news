import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchArticle } from "../src/article.js";
import { parseConfig } from "../src/config.js";
import { dedupe } from "../src/dedupe.js";
import { discover } from "../src/discover.js";
import { filterItems } from "../src/filter.js";
import { renderArticle } from "../src/render.js";
import { contextFor, extractiveSummarizer } from "../src/summarize.js";
import { fixtureFetch, type FixtureRoute } from "../src/fixture-fetch.js";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const NOW = new Date("2026-11-12T12:00:00Z");

export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

export function fixtureConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({ ...JSON.parse(readFixture("config.json")), ...overrides });
}

/** The fixture web: canned responses from web.json, plus extra routes. */
export function fixtureWeb(extra: Record<string, FixtureRoute> = {}) {
  const routes = JSON.parse(readFixture("web.json")) as Record<string, FixtureRoute>;
  return fixtureFetch({ ...routes, ...extra }, readFixture);
}

/** The first fixture story through every stage up to render. */
export async function renderFirst() {
  const config = fixtureConfig();
  const web = fixtureWeb();
  const { items } = await discover(config, web.fetch);
  const [item] = dedupe(filterItems(items, config, NOW).kept).kept;
  const article = await fetchArticle(item, config, { fetch: web.fetch });
  const summary = await extractiveSummarizer()({
    article, matched: item.matched, context: contextFor(config, item.matched), language: "en", tone: "neutral",
  });
  return renderArticle(article, summary, config, item.matched, NOW);
}
