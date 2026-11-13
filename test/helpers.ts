import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const NOW = new Date("2026-11-12T12:00:00Z");

export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

export function fixtureConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({ ...JSON.parse(readFixture("config.json")), ...overrides });
}
