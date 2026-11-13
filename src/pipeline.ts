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

const SEEN: StateRecord["status"][] = ["published", "pending_approval", "approved", "partial"];

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
  if (!dryRun && io.targets.length === 0) throw new StageError("no_targets", "a live run needs at least one target");
  // Receipts are matched to targets by name, so each name must be unique.
  const names = io.targets.map((t) => t.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) throw new StageError("duplicate_target_name", `${twice || "(empty)"}: give each target its own name`);
  if (names.some((n) => !n.trim())) throw new StageError("empty_target_name", "every target needs a name");
  // A store may be shared by several sites; only this site's records count.
  const records = (await io.store.list()).filter((r) => r.postKey.startsWith(`${config.site}:`));
  const byKey = new Map(records.map((r) => [r.key, r]));
  const today = now.toISOString().slice(0, 10);
  let capLeft = config.maxItemsPerDay - records.filter((r) => (r.status === "published" || r.status === "partial") && r.at.startsWith(today)).length;
  const items: ItemResult[] = [];

  const publish = async (key: string, url: string, article: RenderedArticle, approver?: string, done: Receipt[] = []): Promise<ItemResult> => {
    if (capLeft <= 0 && done.length === 0) return { key, url, status: "rejected", stage: "publish", reasons: [{ reason: "daily_cap", detail: `${config.maxItemsPerDay} a day` }], article, receipts: [] };
    if (dryRun) {
      capLeft--;
      return { key, url, status: "would_publish", reasons: [], article, receipts: [] };
    }
    const receipts: Receipt[] = [...done];
    for (const target of io.targets) {
      if (receipts.some((r) => r.target === target.name)) continue;
      try {
        receipts.push(await target.publish(article, now));
      } catch (error) {
        const detail = `${target.name}: ${error instanceof Error ? error.message : String(error)}`;
        // Keep what succeeded, so a retry does not call those targets again.
        if (receipts.length) {
          // A partial publish is out in the world, so it uses today's allowance.
          if (done.length === 0) capLeft--;
          await io.store.put({ key, postKey: article.data.postKey, url, status: "partial", at: now.toISOString(), article, receipts, approver });
        }
        return { key, url, status: "publish_failed", stage: "publish", reasons: [{ reason: "publish_failed", detail }], article, receipts };
      }
    }
    if (done.length === 0) capLeft--;
    await io.store.put({ key, postKey: article.data.postKey, url, status: "published", at: now.toISOString(), receipts, approver });
    return { key, url, status: "published", reasons: [], article, receipts };
  };

  // Items a person approved, and partial publishes, go first.
  for (const record of records.filter((r) => (r.status === "approved" || r.status === "partial") && r.article)) {
    items.push(await publish(record.key, record.url, record.article as RenderedArticle, record.approver, record.receipts ?? []));
  }

  const found = await discover(config, io.fetch, robots);
  const filtered = filterItems(found.items, config, now);
  const deduped = dedupe(filtered.kept, new Set(records.filter((r) => SEEN.includes(r.status)).map((r) => r.key)));
  const reported = new Set<string>();
  for (const r of [...filtered.rejected, ...deduped.rejected]) {
    const stored = byKey.get(r.key);
    // A stored story found again (often in a second feed) is reported once.
    if (r.reason === "already_processed" && (stored?.status === "approved" || stored?.status === "partial" || reported.has(r.key))) continue;
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
    const findings = verifySummary(summary, source.text, {
      sourceMeta: [source.title, source.sourceName],
      hostText: [config.siteName ?? "", ...context.flatMap((c) => [c.note, c.relatedLink?.title ?? ""])],
      requireContext: config.requireContext,
    });
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
