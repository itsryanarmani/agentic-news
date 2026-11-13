import { describe, expect, test } from "vitest";
import { runNews, type RunIO } from "../src/pipeline.js";
import type { RenderedArticle } from "../src/render.js";
import { approveItem, MemoryStateStore } from "../src/state.js";
import type { PublishTarget } from "../src/targets.js";
import { fixtureConfig, fixtureWeb, NOW } from "./helpers.js";

// The whole pipeline on the fixture web, with a target that records calls.
function recorder(fail = false) {
  const published: RenderedArticle[] = [];
  const target: PublishTarget = {
    name: "recorder",
    async publish(article, at) {
      if (fail) throw new Error("target down");
      published.push(article);
      return { target: "recorder", postKey: article.data.postKey, id: article.data.slug, at: at.toISOString() };
    },
  };
  return { target, published };
}

function io(extra: Partial<RunIO> = {}): RunIO {
  return { fetch: fixtureWeb().fetch, now: () => NOW, store: new MemoryStateStore(), targets: [recorder().target], ...extra };
}

const byUrl = (report: Awaited<ReturnType<typeof runNews>>) =>
  Object.fromEntries(report.items.map((i) => [i.url, `${i.status}${i.reasons[0] ? ` ${i.reasons[0].reason}` : ""}`]));

describe("runNews end to end on fixtures", () => {
  test("dry run is the default: every stage runs, no target is called, nothing is stored", async () => {
    const rec = recorder();
    const store = new MemoryStateStore();
    const report = await runNews(fixtureConfig(), io({ store, targets: [rec.target] }));
    expect(report.dryRun).toBe(true);
    expect(rec.published).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(report.sourceErrors.map((e) => e.reason)).toEqual(["network_error", "malformed_feed"]);
    expect(byUrl(report)).toMatchObject({
      "https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss": "would_publish",
      "https://news.example.test/2026/11/installer-backlog": "rejected redirect_off_allow_list",
      "https://news.example.test/2026/11/members-only": "rejected paywall",
      "https://agency.example.test/notices/efficiency-standard": "rejected no_added_context",
      "https://news.example.test/2026/11/bakery": "rejected off_topic",
    });
  });

  test("F18: a live run publishes once; a retried run publishes nothing again", async () => {
    const rec = recorder();
    const run = io({ targets: [rec.target] });
    const first = await runNews(fixtureConfig(), run, { dryRun: false });
    expect(first.counts.published).toBe(1);
    const second = await runNews(fixtureConfig(), run, { dryRun: false });
    expect(second.counts.published).toBeUndefined();
    expect(second.counts.already_published).toBe(1);
    expect(rec.published).toHaveLength(1);
  });

  test("F17: a sensitive item waits for approval, then publishes on the next run", async () => {
    const rec = recorder();
    const run = io({ targets: [rec.target] });
    const config = fixtureConfig({ sensitive: true });
    const first = await runNews(config, run, { dryRun: false });
    expect(first.counts).toMatchObject({ pending_approval: 1 });
    expect((await runNews(config, run, { dryRun: false })).counts.pending_approval).toBe(1);
    expect(rec.published).toEqual([]);
    const pending = first.items.find((i) => i.status === "pending_approval");
    await approveItem(run.store, pending?.article?.data.postKey ?? "", "editor", NOW);
    const third = await runNews(config, run, { dryRun: false });
    expect(third.counts.published).toBe(1);
    expect(rec.published).toHaveLength(1);
    expect((await run.store.list())[0]).toMatchObject({ status: "published", approver: "editor" });
  });

  test("an approval hook that says no stops the item", async () => {
    const report = await runNews(fixtureConfig({ sensitive: true }), io({ approval: async () => ({ approved: false, reason: "off brand" }) }), { dryRun: false });
    expect(report.items.find((i) => i.reasons[0]?.reason === "approval_denied")?.reasons[0].detail).toBe("off brand");
  });

  test("F19: a failing target is reported and the item is retried on the next run", async () => {
    const store = new MemoryStateStore();
    const failed = await runNews(fixtureConfig(), io({ store, targets: [recorder(true).target] }), { dryRun: false });
    expect(failed.counts.publish_failed).toBe(1);
    expect(failed.items.find((i) => i.status === "publish_failed")?.reasons[0].detail).toBe("recorder: target down");
    expect(await store.list()).toEqual([]);
    const retry = await runNews(fixtureConfig(), io({ store }), { dryRun: false });
    expect(retry.counts.published).toBe(1);
  });

  test("F20: items past maxItemsPerDay are held back", async () => {
    const config = fixtureConfig({
      maxItemsPerDay: 1,
      context: [{ keyword: "heat pump", note: "Our directory lists certified installers by region, so compare three quotes before you buy." }],
    });
    const report = await runNews(config, io(), { dryRun: false });
    expect(report.counts.published).toBe(1);
    expect(report.items.filter((i) => i.reasons[0]?.reason === "daily_cap")).toHaveLength(1);
  });

  test("F13: a host summarizer that invents a figure is rejected at verify", async () => {
    const summarizer = () => ({ tldr: "The rebate now pays up to $9,000.", whyItMatters: "Our directory lists installers who handle rebate paperwork for renters and owners alike." });
    const report = await runNews(fixtureConfig(), io({ summarizer }), { dryRun: false });
    expect(report.counts.published).toBeUndefined();
    expect(byUrl(report)["https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss"]).toBe("rejected unsupported_amount");
  });

  test("review: a partial publish is kept, and the retry calls only the failed target", async () => {
    const good = recorder();
    let calls = 0;
    const flaky: PublishTarget = {
      name: "flaky",
      async publish(article, at) {
        calls++;
        if (calls === 1) throw new Error("down once");
        return { target: "flaky", postKey: article.data.postKey, id: "1", at: at.toISOString() };
      },
    };
    const run = io({ targets: [good.target, flaky] });
    expect((await runNews(fixtureConfig(), run, { dryRun: false })).counts.publish_failed).toBe(1);
    expect((await run.store.list())[0].status).toBe("partial");
    const retry = await runNews(fixtureConfig(), run, { dryRun: false });
    expect(retry.counts.published).toBe(1);
    expect(good.published).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("review: another site's approved items in a shared store are left alone", async () => {
    const store = new MemoryStateStore();
    const sensitive = io({ store });
    const first = await runNews(fixtureConfig({ sensitive: true, site: "site-a" }), sensitive, { dryRun: false });
    await approveItem(store, first.items.find((i) => i.status === "pending_approval")?.article?.data.postKey ?? "", "editor", NOW);
    const rec = recorder();
    const other = await runNews(fixtureConfig({ site: "site-b" }), io({ store, targets: [rec.target] }), { dryRun: false });
    expect(rec.published.map((a) => a.data.postKey.split(":")[0])).toEqual(["site-b"]);
    expect(other.counts.published).toBe(1);
    expect((await store.list()).map((r) => `${r.postKey.split(":")[0]} ${r.status}`).sort()).toEqual(["site-a approved", "site-b published"]);
  });

  test("review: a live run with no targets is refused, not recorded as published", async () => {
    const store = new MemoryStateStore();
    await expect(runNews(fixtureConfig(), io({ store, targets: [] }), { dryRun: false })).rejects.toMatchObject({ reason: "no_targets" });
    expect(await store.list()).toEqual([]);
  });

  test("review round 2: duplicate target names are refused; a partial publish uses the daily cap", async () => {
    const a = recorder();
    await expect(runNews(fixtureConfig(), io({ targets: [a.target, a.target] }), { dryRun: false })).rejects.toMatchObject({ reason: "duplicate_target_name" });
    const config = fixtureConfig({
      maxItemsPerDay: 1,
      context: [{ keyword: "heat pump", note: "Our directory lists certified installers by region, so compare three quotes before you buy." }],
    });
    const good = recorder();
    const bad: PublishTarget = { name: "bad", async publish() { throw new Error("down"); } };
    const report = await runNews(config, io({ targets: [good.target, bad] }), { dryRun: false });
    expect(good.published).toHaveLength(1);
    expect(report.items.filter((i) => i.reasons[0]?.reason === "daily_cap")).toHaveLength(1);
  });
});
