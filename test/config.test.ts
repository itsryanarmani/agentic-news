import { describe, expect, test } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { fixtureConfig } from "./helpers.js";

describe("news config", () => {
  test("the fixture config parses and gets safe defaults", () => {
    const config = fixtureConfig();
    expect(config.site).toBe("example-niche");
    expect(config.sources.every((s) => s.kind === "feed")).toBe(true);
    expect(config.maxBytes).toBe(1_000_000);
    expect(config.requireContext).toBe(true);
  });

  test("a bad config lists every problem at once", () => {
    let caught: unknown;
    try {
      parseConfig({ site: "Bad Site", keywords: [], sources: [{ name: "x", url: "ftp://x" }], recencyHours: -1, sensitive: "yes" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems).toEqual([
      "site must be a lowercase id (a-z, 0-9, -)",
      "keywords must be a non-empty list of strings",
      "sources[0].url must be an http(s) URL",
      "recencyHours must be a positive number",
      "sensitive must be true or false",
    ]);
  });

  test("a non-object config is refused", () => {
    expect(() => parseConfig([])).toThrowError("config must be a JSON object");
  });
});
