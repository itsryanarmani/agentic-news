import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fileTarget, httpTarget, jsonQueueFile, queueTarget, socialText } from "../src/targets.js";
import { NOW, renderFirst } from "./helpers.js";

describe("publish targets", () => {
  test("the file target writes markdown and JSON named by slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anw-files-"));
    const article = await renderFirst();
    const receipt = await fileTarget({ dir }).publish(article, NOW);
    expect((await readdir(dir)).sort()).toEqual([`${article.data.slug}.json`, `${article.data.slug}.md`]);
    expect(await readFile(join(dir, `${article.data.slug}.md`), "utf8")).toBe(article.markdown);
    expect(receipt).toMatchObject({ target: "file", id: article.data.slug, at: NOW.toISOString() });
  });

  test("the HTTP target sends a bearer token from the resolver, an idempotency key, and refuses redirects", async () => {
    const article = await renderFirst();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return Response.json({ id: "remote-1" }, { status: 201 });
    };
    const target = httpTarget({ endpoint: "https://api.example.test/news", token: async () => "test-token", fetch });
    expect(await target.publish(article, NOW)).toMatchObject({ target: "http", id: "remote-1" });
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["idempotency-key"]).toBe(article.data.postKey);
    expect(seen[0].init.redirect).toBe("error");
    expect(JSON.parse(String(seen[0].init.body)).article.source_url).toBe(article.data.source_url);
  });

  test("F19: an HTTP failure or a missing token throws, never a false receipt", async () => {
    const article = await renderFirst();
    const down = httpTarget({ endpoint: "https://api.example.test/news", token: () => "t", fetch: async () => new Response("no", { status: 500 }) });
    await expect(down.publish(article, NOW)).rejects.toMatchObject({ reason: "http_target_failed" });
    const noToken = httpTarget({ endpoint: "https://api.example.test/news", token: () => "", fetch: async () => Response.json({}) });
    await expect(noToken.publish(article, NOW)).rejects.toMatchObject({ reason: "missing_token" });
  });

  test("the queue target writes one agentic-publish entry per post key, at most 300 chars, with the link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anw-queue-"));
    const store = jsonQueueFile(join(dir, "queue.json"));
    const article = await renderFirst();
    const target = queueTarget({ brand: "example-niche", channels: ["x", "linkedin"], store, linkFor: (a) => `https://directory.example.test/news/${a.data.slug}` });
    await target.publish(article, NOW);
    await target.publish(article, NOW);
    const queue = await store.load();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: article.data.postKey, brand: "example-niche", attempts: 0, post: { targets: ["x", "linkedin"] } });
    expect(queue[0].post.text.length).toBeLessThanOrEqual(300);
    expect(queue[0].post.text.endsWith(`https://directory.example.test/news/${article.data.slug}`)).toBe(true);
    expect(queue[0].post.text.startsWith("Province expands heat pump rebate to renters (via Example News)")).toBe(true);
  });

  test("a long headline is cut so the post still fits with its link", async () => {
    const article = await renderFirst();
    const long = { ...article, data: { ...article.data, title: "Heat pump ".repeat(60).trim(), why_it_matters: "" } };
    const text = socialText(long, "https://directory.example.test/n/1");
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("… (via Example News)\n\nhttps://directory.example.test/n/1")).toBe(true);
  });
});
