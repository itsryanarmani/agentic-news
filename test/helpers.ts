import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
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
