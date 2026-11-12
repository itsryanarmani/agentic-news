import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { fixtureWeb, NOW, readFixture } from "./helpers.js";

// A real MCP client talks to the server over an in-memory transport.
async function connect() {
  const server = createMcpServer({ fetch: fixtureWeb().fetch, now: () => NOW });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0].text) };
  };
  return { client, call };
}

const config = JSON.parse(readFixture("config.json"));

describe("MCP server", () => {
  test("lists the tools, and offers no approve tool", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_pending", "run_news", "validate_config", "verify_summary"]);
  });

  test("validate_config returns every problem", async () => {
    const { call } = await connect();
    const r = await call("validate_config", { config: { site: "X" } });
    expect(r.isError).toBe(true);
    expect(r.body.problems).toContain("site must be a lowercase id (a-z, 0-9, -)");
  });

  test("verify_summary flags an invented number for an agent's own draft", async () => {
    const { call } = await connect();
    const r = await call("verify_summary", { sourceText: "The rebate is $5,000.", tldr: "The rebate is now $6,000.", whyItMatters: "", requireContext: false });
    expect(r.body.findings.map((f: { reason: string }) => f.reason)).toEqual(["unsupported_amount", "unsupported_number"]);
  });

  test("run_news is a dry run by default; live needs approved and a target", async () => {
    const { call } = await connect();
    const dir = mkdtempSync(join(tmpdir(), "anw-mcp-"));
    const statePath = join(dir, "state.json");
    const dry = await call("run_news", { config, statePath });
    expect(dry.body).toMatchObject({ dryRun: true, counts: { would_publish: 1 } });
    expect((await call("run_news", { config, statePath, live: true })).body.error).toBe("a live run needs approved: true from the user");
    expect((await call("run_news", { config, statePath, live: true, approved: true })).body.error).toBe("a live run needs outDir or queuePath");
    const queuePath = join(dir, "queue.json");
    const live = await call("run_news", { config, statePath, live: true, approved: true, queuePath, channels: ["linkedin"] });
    expect(live.body.counts.published).toBe(1);
    expect(JSON.parse(readFileSync(queuePath, "utf8"))[0].post.targets).toEqual(["linkedin"]);
  });

  test("a sensitive live run only queues for approval, which list_pending shows", async () => {
    const { call } = await connect();
    const dir = mkdtempSync(join(tmpdir(), "anw-mcp-"));
    const statePath = join(dir, "state.json");
    const live = await call("run_news", { config: { ...config, sensitive: true }, statePath, live: true, approved: true, outDir: dir });
    expect(live.body.counts.pending_approval).toBe(1);
    expect((await call("list_pending", { statePath })).body).toHaveLength(1);
  });
});
