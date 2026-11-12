import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigError, parseConfig } from "./config.js";
import { runNews } from "./pipeline.js";
import { FileStateStore } from "./state.js";
import { fileTarget, jsonQueueFile, queueTarget, type Channel, type PublishTarget } from "./targets.js";
import type { FetchLike } from "./types.js";
import { verifySummary } from "./verify.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  fetch?: FetchLike;
  now?: () => Date;
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }) }], isError: true as const };
}

/**
 * Tools over the same core as the SDK and CLI. There is no approve tool on
 * purpose: approving a sensitive item is a human step, done with the CLI.
 */
export function createMcpServer(deps: McpDeps = {}): McpServer {
  const server = new McpServer({ name: "agentic-news", version: VERSION });

  server.registerTool("validate_config", {
    description: "Check an agentic-news site config. Returns the config with defaults, or every problem.",
    inputSchema: { config: z.record(z.unknown()) },
    annotations: { readOnlyHint: true },
  }, async ({ config }) => {
    try {
      return ok(parseConfig(config));
    } catch (error) {
      if (error instanceof ConfigError) return fail("invalid config", { problems: error.problems });
      throw error;
    }
  });

  server.registerTool("verify_summary", {
    description: "Check a TL;DR and why-it-matters against the source text: facts must appear in the source, TL;DR at most 2 sentences, no copied 8-word runs outside one short quote, added context. Returns findings; empty means it passes.",
    inputSchema: {
      sourceText: z.string(),
      tldr: z.string(),
      whyItMatters: z.string(),
      trusted: z.array(z.string()).optional().describe("Host text the summary may also draw facts from."),
      requireContext: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ sourceText, tldr, whyItMatters, trusted, requireContext }) =>
    ok({ findings: verifySummary({ tldr, whyItMatters }, sourceText, { trusted: trusted ?? [], requireContext: requireContext ?? true }) }));

  server.registerTool("run_news", {
    description: "Run one site through discover, filter, dedupe, fetch, summarize, verify and render. Dry run by default. A live run needs live: true, approved: true and a target (outDir or queuePath). Sensitive items are only queued for human approval.",
    inputSchema: {
      config: z.record(z.unknown()),
      statePath: z.string(),
      live: z.boolean().optional(),
      approved: z.boolean().optional().describe("Set true only after the user approved this live run."),
      outDir: z.string().optional(),
      queuePath: z.string().optional(),
      channels: z.array(z.enum(["x", "linkedin", "tiktok", "instagram"])).optional(),
    },
    annotations: { openWorldHint: true },
  }, async ({ config: raw, statePath, live, approved, outDir, queuePath, channels }) => {
    let config;
    try {
      config = parseConfig(raw);
    } catch (error) {
      if (error instanceof ConfigError) return fail("invalid config", { problems: error.problems });
      throw error;
    }
    if (live && !approved) return fail("a live run needs approved: true from the user");
    const targets: PublishTarget[] = [];
    if (outDir) targets.push(fileTarget({ dir: outDir }));
    if (queuePath) targets.push(queueTarget({ brand: config.site, channels: (channels ?? ["x"]) as Channel[], store: jsonQueueFile(queuePath) }));
    if (live && targets.length === 0) return fail("a live run needs outDir or queuePath");
    const report = await runNews(config, {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? (() => new Date()),
      store: new FileStateStore(statePath),
      targets,
    }, { dryRun: !live });
    return ok({ ...report, items: report.items.map(({ article, ...rest }) => ({ ...rest, tldr: article?.data.tldr })) });
  });

  server.registerTool("list_pending", {
    description: "List items waiting for human approval in a state file.",
    inputSchema: { statePath: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ statePath }) => {
    const records = await new FileStateStore(statePath).list();
    return ok(records.filter((r) => r.status === "pending_approval")
      .map((r) => ({ postKey: r.postKey, url: r.url, title: r.article?.data.title, tldr: r.article?.data.tldr })));
  });

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  await createMcpServer(deps).connect(new StdioServerTransport());
}
