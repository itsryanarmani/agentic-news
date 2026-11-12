import { fetchArticle, type RobotsCache } from "./article.js";
import { dedupe } from "./dedupe.js";
import { discover } from "./discover.js";
import { filterItems } from "./filter.js";
import { checkAttribution, renderArticle, type RenderedArticle } from "./render.js";
import type { StateRecord, StateStore } from "./state.js";
import { contextFor, extractiveSummarizer, type Summarizer } from "./summarize.js";
import type { PublishTarget, Receipt } from "./targets.js";
import { StageError, type FetchLike, type NewsConfig, type NewsItem, type SourceError, type Stage } from "./types.js";
import { verifySummary, type Finding } from "./verify.js";

export interface ApprovalDecision { approved: boolean; approver?: string; reason?: string }
/** Asked for every item when given. Required for a sensitive config; without it, items wait as pending. */
export type ApprovalHook = (article: RenderedArticle) => Promise<ApprovalDecision>;

export interface RunIO {
  fetch: FetchLike;
  now: () => Date;
  store: StateStore;
  targets: PublishTarget[];
  summarizer?: Summarizer;
  approval?: ApprovalHook;
  robots?: RobotsCache;
}

export type ItemStatus =
  | "published" | "would_publish" | "pending_approval" | "already_published" | "rejected" | "publish_failed";

export interface ItemResult {
  key: string;
  url: string;
  status: ItemStatus;
  stage?: Stage;
  reasons: Finding[];
  article?: RenderedArticle;
  receipts: Receipt[];
}

export interface RunReport {
  site: string;
  dryRun: boolean;
  startedAt: string;
  sourceErrors: SourceError[];
  items: ItemResult[];
  counts: Partial<Record<ItemStatus, number>>;
}

const SEEN: StateRecord["status"][] = ["published", "pending_approval", "approved"];

/**
 * One run for one site. Dry run is the default: every stage runs, but no
 * target is called and nothing is stored. The host owns scheduling; this
 * function holds no timers.
 */
export async function runNews(config: NewsConfig, io: RunIO, options: { dryRun?: boolean } = {}): Promise<RunReport> {
  const dryRun = options.dryRun ?? true;
  const now = io.now();
  const summarize = io.summarizer ?? extractiveSummarizer();
  const robots: RobotsCache = io.robots ?? new Map();
  const records = await io.store.list();
  const byKey = new Map(records.map((r) => [r.key, r]));
  const today = now.toISOString().slice(0, 10);
  let capLeft = config.maxItemsPerDay - records.filter((r) => r.status === "published" && r.at.startsWith(today)).length;
  const items: ItemResult[] = [];

  const publish = async (key: string, url: string, article: RenderedArticle, approver?: string): Promise<ItemResult> => {
    if (capLeft <= 0) return { key, url, status: "rejected", stage: "publish", reasons: [{ reason: "daily_cap", detail: `${config.maxItemsPerDay} a day` }], article, receipts: [] };
    if (dryRun) {
      capLeft--;
      return { key, url, status: "would_publish", reasons: [], article, receipts: [] };
    }
    const receipts: Receipt[] = [];
    for (const target of io.targets) {
      try {
        receipts.push(await target.publish(article, now));
      } catch (error) {
        const detail = `${target.name}: ${error instanceof Error ? error.message : String(error)}`;
        return { key, url, status: "publish_failed", stage: "publish", reasons: [{ reason: "publish_failed", detail }], article, receipts };
      }
    }
    capLeft--;
    await io.store.put({ key, postKey: article.data.postKey, url, status: "published", at: now.toISOString(), receipts, approver });
    return { key, url, status: "published", reasons: [], article, receipts };
  };

  // Items a person approved since the last run go first.
  for (const record of records.filter((r) => r.status === "approved" && r.article)) {
    items.push(await publish(record.key, record.url, record.article as RenderedArticle, record.approver));
  }

  const found = await discover(config, io.fetch);
  const filtered = filterItems(found.items, config, now);
  const deduped = dedupe(filtered.kept, new Set(records.filter((r) => SEEN.includes(r.status)).map((r) => r.key)));
  const reported = new Set<string>();
  for (const r of [...filtered.rejected, ...deduped.rejected]) {
    const stored = byKey.get(r.key);
    // A stored story found again (often in a second feed) is reported once.
    if (r.reason === "already_processed" && (stored?.status === "approved" || reported.has(r.key))) continue;
    reported.add(r.key);
    const status: ItemStatus = r.reason === "already_processed" ? (stored?.status === "published" ? "already_published" : "pending_approval") : "rejected";
    items.push({ key: r.key, url: r.url, status, stage: r.stage, reasons: status === "rejected" ? [{ reason: r.reason, detail: r.detail ?? "" }] : [], receipts: [] });
  }

  for (const item of deduped.kept) items.push(await processItem(item));

  async function processItem(item: NewsItem): Promise<ItemResult> {
    const reject = (stage: Stage, reasons: Finding[], article?: RenderedArticle): ItemResult =>
      ({ key: item.key, url: item.url, status: "rejected", stage, reasons, article, receipts: [] });
    let source;
    try {
      source = await fetchArticle(item, config, { fetch: io.fetch, robots });
    } catch (error) {
      if (!(error instanceof StageError)) throw error;
      return reject("fetch", [{ reason: error.reason, detail: error.message }]);
    }
    const context = contextFor(config, item.matched);
    let summary;
    try {
      summary = await summarize({ article: source, matched: item.matched, context, language: config.language, tone: config.tone });
    } catch (error) {
      return reject("summarize", [{ reason: "summarizer_failed", detail: error instanceof Error ? error.message : String(error) }]);
    }
    const trusted = [source.title, source.sourceName, config.siteName ?? "", ...context.flatMap((c) => [c.note, c.relatedLink?.title ?? ""])];
    const findings = verifySummary(summary, source.text, { trusted, requireContext: config.requireContext });
    if (findings.length) return reject("verify", findings);
    const article = renderArticle(source, summary, config, item.matched, now);
    const attribution = checkAttribution(article, config);
    if (attribution.length) return reject("verify", attribution, article);

    const pending = (): ItemResult =>
      ({ key: item.key, url: item.url, status: "pending_approval", stage: "approve", reasons: [{ reason: "needs_approval", detail: "sensitive config" }], article, receipts: [] });
    // A dry run never asks a person; it only shows what would wait.
    if (dryRun) return config.sensitive ? pending() : publish(item.key, item.url, article);
    if (io.approval) {
      const decision = await io.approval(article);
      if (!decision.approved) return reject("approve", [{ reason: "approval_denied", detail: decision.reason ?? "" }], article);
      return publish(item.key, item.url, article, decision.approver);
    }
    if (config.sensitive) {
      await io.store.put({ key: item.key, postKey: article.data.postKey, url: item.url, status: "pending_approval", at: now.toISOString(), article });
      return pending();
    }
    return publish(item.key, item.url, article);
  }

  const counts: Partial<Record<ItemStatus, number>> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return { site: config.site, dryRun, startedAt: now.toISOString(), sourceErrors: found.errors, items, counts };
}
