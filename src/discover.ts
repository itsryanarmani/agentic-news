import { canonicalUrl, contentHash, itemKey } from "./keys.js";
import { parseFeed, parsePage, type FeedEntry } from "./feed.js";
import { checkRobots, type RobotsCache } from "./article.js";
import { boundedGet, hostOf, type GetOptions } from "./http.js";
import { StageError, type FetchLike, type NewsConfig, type NewsItem, type SourceError } from "./types.js";

export interface DiscoverResult {
  items: NewsItem[];
  errors: SourceError[];
}

export function toItem(entry: FeedEntry, sourceName: string, feedUrl: string): NewsItem | undefined {
  let canonical: string;
  try {
    canonical = canonicalUrl(entry.url);
  } catch {
    return undefined;
  }
  return {
    key: itemKey(canonical),
    title: entry.title,
    url: entry.url,
    canonicalUrl: canonical,
    sourceName,
    feedUrl,
    publishedAt: entry.publishedAt,
    summary: entry.summary,
    contentHash: contentHash(entry.title, entry.summary),
    matched: [],
  };
}

/**
 * Read every allow-listed source in config order. A source that fails is
 * reported in errors and the run goes on with the others.
 */
export async function discover(config: NewsConfig, fetch: FetchLike, robots: RobotsCache = new Map()): Promise<DiscoverResult> {
  const items: NewsItem[] = [];
  const errors: SourceError[] = [];
  for (const source of config.sources) {
    try {
      const get: GetOptions = {
        fetch,
        allowHosts: [hostOf(source.url)],
        blockHosts: config.blockedDomains,
        maxBytes: config.maxBytes,
        timeoutMs: config.timeoutMs,
        userAgent: config.userAgent,
        accept: source.kind === "page" ? "text/html" : "application/rss+xml, application/atom+xml, application/xml, text/xml",
      };
      // Feeds obey robots.txt too, on every hop.
      const got = await boundedGet(source.url, { ...get, beforeRequest: (url) => checkRobots(url, get, robots) });
      if (got.status >= 400) throw new StageError("source_down", `status ${got.status}`);
      const entries = source.kind === "page" ? parsePage(got.body, got.url) : parseFeed(got.body, got.url);
      for (const entry of entries) {
        const item = toItem(entry, source.name, source.url);
        if (item) items.push(item);
      }
    } catch (error) {
      const reason = error instanceof StageError ? error.reason : "source_error";
      errors.push({ source: source.name, url: source.url, reason, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { items, errors };
}
