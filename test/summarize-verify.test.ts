import { describe, expect, test } from "vitest";
import { fetchArticle, type SourceArticle } from "../src/article.js";
import { dedupe } from "../src/dedupe.js";
import { discover } from "../src/discover.js";
import { filterItems } from "../src/filter.js";
import { contextFor, extractiveSummarizer, type Summary } from "../src/summarize.js";
import { verifySummary } from "../src/verify.js";
import { fixtureConfig, fixtureWeb, NOW } from "./helpers.js";

const config = fixtureConfig();

// Real stages up to the fetched source articles, on the fixture web.
async function sources(): Promise<Array<{ article: SourceArticle; matched: string[] }>> {
  const web = fixtureWeb();
  const { items } = await discover(config, web.fetch);
  const { kept } = dedupe(filterItems(items, config, NOW).kept);
  const out = [];
  for (const item of kept) {
    try {
      out.push({ article: await fetchArticle(item, config, { fetch: web.fetch }), matched: item.matched });
    } catch {
      // Fetch failures are covered in article.test.ts.
    }
  }
  return out;
}

function check(summary: Summary, article: SourceArticle) {
  const trusted = [article.title, article.sourceName, ...config.context.map((c) => c.note)];
  return verifySummary(summary, article.text, { trusted, requireContext: true }).map((f) => `${f.reason}: ${f.detail}`);
}

describe("summarize and verify on fixture articles", () => {
  test("the extractive default passes when the host gave context, and fails without it", async () => {
    const [rebate, standard] = await sources();
    const summarize = extractiveSummarizer();
    const input = (s: typeof rebate) => ({ ...s, context: contextFor(config, s.matched), language: "en", tone: config.tone });
    const good = await summarize(input(rebate));
    expect(good.tldr).toBe('Example News reports: "The Example Province energy ministry said on November 12, 2026 that renters can now apply for the heat pump rebate."');
    expect(good.relatedLink?.url).toBe("https://directory.example.test/guides/rebates");
    expect(check(good, rebate.article)).toEqual([]);
    expect(check(await summarize(input(standard)), standard.article)).toEqual(["no_added_context: why it matters is empty"]);
  });

  const paraphrase: Summary = {
    tldr: "Renters in Example Province may now seek the heat pump rebate, worth up to $5,000 per home. Applications open on December 1, 2026.",
    whyItMatters: "If you rent, ask your landlord for written consent early, since no installer can begin work without it.",
  };

  test("an honest paraphrase from a host summarizer passes", async () => {
    const [rebate] = await sources();
    expect(check(paraphrase, rebate.article)).toEqual([]);
  });

  test("F13: an invented number, amount, date or name is rejected", async () => {
    const [rebate] = await sources();
    const invented = {
      tldr: "Renters may now seek a rebate worth up to $7,500, says Minister Jordan Quill. Applications open on January 5.",
      whyItMatters: "About 55,000 households could save money, so ask your landlord for consent early this winter.",
    };
    expect(check(invented, rebate.article)).toEqual([
      "unsupported_amount: $7,500",
      "unsupported_date: January 5",
      "unsupported_number: 7,500",
      "unsupported_number: 5",
      "unsupported_name: Jordan",
      "unsupported_name: Quill",
      "unsupported_date: January",
      "unsupported_number: 55,000",
    ]);
  });

  test("F14: a summary that copies the source is rejected, one short quote is allowed", async () => {
    const [rebate] = await sources();
    const copied = { ...paraphrase, tldr: "Renters can now apply for the heat pump rebate, the ministry said." };
    expect(check(copied, rebate.article)).toEqual(["copied_run: renters can now apply for the heat pump rebate"]);
    const twoQuotes = { ...paraphrase, tldr: 'The rebate is "up to $5,000". Renters "need written consent".' };
    expect(check(twoQuotes, rebate.article)).toEqual(["too_many_quotes: need written consent"]);
  });

  test("F15: a TL;DR over 2 sentences is rejected", async () => {
    const [rebate] = await sources();
    const long = { ...paraphrase, tldr: "Renters qualify now. The cap is $5,000. Applications open on December 1, 2026." };
    expect(check(long, rebate.article)).toEqual(["tldr_too_long: 3 sentences"]);
  });

  test("F16: a why-it-matters that restates the source is rejected", async () => {
    const [rebate] = await sources();
    const thin = { ...paraphrase, whyItMatters: "The rebate covers the cost of a new heat pump for renters and owners." };
    expect(check(thin, rebate.article)).toEqual(["no_added_context: why it matters restates the source"]);
  });
});
