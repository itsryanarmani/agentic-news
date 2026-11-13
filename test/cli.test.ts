import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

// Spawns the built CLI, as a host's cron job would. No network: --fixtures.
const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const F = join(ROOT, "test", "fixtures");
const BASE = ["--fixtures", join(F, "web.json"), "--now", "2026-11-12T12:00:00Z"];

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, TEST_NEWS_TOKEN: "t" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  if (!existsSync(CLI)) execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
}, 60_000);

// Each case spawns the CLI several times; allow for a slow machine.
describe("agentic-news CLI end to end", { timeout: 30_000 }, () => {
  test("dry run writes nothing; live run writes files, queue and state; retry adds nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "anw-cli-"));
    const state = join(dir, "state.json");
    const dry = cli("run", "--config", join(F, "config.json"), ...BASE, "--state", state);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out).counts).toEqual({ rejected: 10, would_publish: 1 });
    expect(existsSync(state)).toBe(false);

    const live = ["run", "--config", join(F, "config.json"), ...BASE, "--state", state, "--live",
      "--out", join(dir, "articles"), "--queue", join(dir, "queue.json"), "--channels", "x,linkedin"];
    expect(JSON.parse(cli(...live).out).counts).toEqual({ rejected: 10, published: 1 });
    expect(readdirSync(join(dir, "articles"))).toHaveLength(2);
    expect(JSON.parse(cli(...live).out).counts).toEqual({ rejected: 9, already_published: 1 });
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"))).toHaveLength(1);
  });

  test("sensitive: pending, approve, then publish", () => {
    const dir = mkdtempSync(join(tmpdir(), "anw-cli-"));
    const state = join(dir, "s.json");
    const run = ["run", "--config", join(F, "config-sensitive.json"), ...BASE, "--state", state, "--live", "--out", dir];
    expect(JSON.parse(cli(...run).out).counts.pending_approval).toBe(1);
    const [pending] = JSON.parse(cli("pending", "--state", state).out);
    expect(cli("approve", "--state", state, "--key", pending.postKey, "--by", "editor").code).toBe(0);
    expect(cli("approve", "--state", state, "--key", pending.postKey, "--by", "editor").code).toBe(1);
    expect(JSON.parse(cli(...run).out).counts.published).toBe(1);
  });

  test("bad input exits 2 with a reason; a failing HTTP target exits 1", () => {
    expect(cli("check-config", "--config", join(ROOT, "package.json"))).toMatchObject({ code: 2, err: expect.stringContaining("site must be") });
    expect(cli("run", "--config", join(F, "config.json"), "--live")).toMatchObject({ code: 2, err: expect.stringContaining("--live needs at least one target") });
    expect(cli("nope").code).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "anw-cli-"));
    const failed = cli("run", "--config", join(F, "config.json"), ...BASE, "--state", join(dir, "s.json"), "--live",
      "--http", "https://api.example.test/news", "--token-env", "TEST_NEWS_TOKEN");
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out).counts.publish_failed).toBe(1);
  });
});
