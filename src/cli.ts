#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig, ConfigError } from "./config.js";
import { fixtureFetch, type FixtureRoute } from "./fixture-fetch.js";
import { runNews, type RunReport } from "./pipeline.js";
import { approveItem, FileStateStore } from "./state.js";
import { fileTarget, httpTarget, jsonQueueFile, queueTarget, type Channel, type PublishTarget } from "./targets.js";
import { StageError, type FetchLike } from "./types.js";
import { VERSION } from "./version.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const HELP = `agentic-news ${VERSION}
Turn niche news into short, sourced, verified articles.

Usage: agentic-news <command> [flags]

Commands:
  check-config --config <file>
  run --config <file> [--live] [--state <file>] [--out <dir>]
      [--queue <file> --channels x,linkedin [--brand <id>] [--link-base <url>]]
      [--http <url> --token-env <NAME>] [--fixtures <web.json>] [--now <iso>] [--brief]
  pending --state <file>
  approve --state <file> --key <post key> --by <name>

Dry run is the default. --live calls the targets and writes state.
The CLI reads a token only from the env var named by --token-env.`;

type Flags = Record<string, string | true>;

export function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new StageError("usage", `unexpected argument "${arg}"`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = args[++i];
  }
  return flags;
}

function need(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") throw new StageError("usage", `--${name} <value> is required`);
  return value;
}

function loadConfig(path: string) {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Compact report for stdout: no article bodies. */
function summary(report: RunReport) {
  return {
    ...report,
    items: report.items.map(({ article, ...rest }) => ({ ...rest, postKey: article?.data.postKey, tldr: article?.data.tldr })),
  };
}

async function run(flags: Flags, io: CliIo): Promise<number> {
  const config = loadConfig(need(flags, "config"));
  const live = flags.live === true;
  let fetch: FetchLike = globalThis.fetch;
  if (typeof flags.fixtures === "string") {
    const manifest = resolve(flags.fixtures);
    const routes = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, FixtureRoute>;
    fetch = fixtureFetch(routes, (p) => readFileSync(join(dirname(manifest), p), "utf8")).fetch;
  }
  const targets: PublishTarget[] = [];
  if (typeof flags.out === "string") targets.push(fileTarget({ dir: flags.out }));
  if (typeof flags.http === "string") {
    const envName = need(flags, "token-env");
    targets.push(httpTarget({ endpoint: flags.http, token: () => io.env[envName] ?? "", fetch }));
  }
  if (typeof flags.queue === "string") {
    const base = typeof flags["link-base"] === "string" ? flags["link-base"].replace(/\/$/, "") : undefined;
    targets.push(queueTarget({
      brand: typeof flags.brand === "string" ? flags.brand : config.site,
      channels: need(flags, "channels").split(",").map((c) => c.trim()) as Channel[],
      store: jsonQueueFile(flags.queue),
      linkFor: base ? (a) => `${base}/${a.data.slug}` : undefined,
    }));
  }
  if (live && targets.length === 0) throw new StageError("usage", "--live needs at least one target: --out, --http or --queue");
  const state = typeof flags.state === "string" ? flags.state : `.agentic-news/${config.site}-state.json`;
  const now = typeof flags.now === "string" ? new Date(flags.now) : undefined;
  if (now && Number.isNaN(now.getTime())) throw new StageError("usage", "--now must be an ISO date");
  const report = await runNews(config, { fetch, now: () => now ?? new Date(), store: new FileStateStore(state), targets }, { dryRun: !live });
  if (flags.brief === true) {
    io.out(`${report.dryRun ? "dry run" : "live"} ${config.site}: ${JSON.stringify(report.counts)}`);
    for (const e of report.sourceErrors) io.out(`  source_error     ${e.reason.padEnd(24)} ${e.url}`);
    for (const i of report.items) io.out(`  ${i.status.padEnd(16)} ${(i.reasons[0]?.reason ?? "").padEnd(24)} ${i.url}`);
  } else {
    io.out(JSON.stringify(summary(report), null, 2));
  }
  return report.counts.publish_failed ? 1 : 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "--help" || command === "-h") { io.out(HELP); return 0; }
    if (command === "--version" || command === "-V") { io.out(VERSION); return 0; }
    const flags = parseFlags(rest);
    if (command === "check-config") {
      const config = loadConfig(need(flags, "config"));
      io.out(JSON.stringify({ ok: true, site: config.site, sources: config.sources.length, sensitive: config.sensitive }));
      return 0;
    }
    if (command === "run") return await run(flags, io);
    if (command === "pending") {
      const records = await new FileStateStore(need(flags, "state")).list();
      const pending = records.filter((r) => r.status === "pending_approval")
        .map((r) => ({ postKey: r.postKey, url: r.url, title: r.article?.data.title, tldr: r.article?.data.tldr }));
      io.out(JSON.stringify(pending, null, 2));
      return 0;
    }
    if (command === "approve") {
      const record = await approveItem(new FileStateStore(need(flags, "state")), need(flags, "key"), need(flags, "by"), new Date());
      io.out(JSON.stringify({ approved: record.postKey, by: record.approver }));
      return 0;
    }
    io.err(`unknown command "${command}". Run agentic-news --help.`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) { io.err(error.message); return 2; }
    if (error instanceof StageError) { io.err(error.message); return error.reason === "usage" ? 2 : 1; }
    if (error instanceof SyntaxError) { io.err(`invalid JSON: ${error.message}`); return 2; }
    throw error;
  }
}

function isMain(): boolean {
  try {
    return typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
