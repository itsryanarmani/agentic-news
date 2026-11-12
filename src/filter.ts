import { hostMatches, hostOf } from "./http.js";
import type { NewsConfig, NewsItem, Rejection } from "./types.js";

export interface FilterResult {
  kept: NewsItem[];
  rejected: Rejection[];
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keywords found in the title or feed summary, as whole words, any case. */
export function matchKeywords(text: string, keywords: string[]): string[] {
  return keywords.filter((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(k)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

/** Hosts the article fetch may reach: the allow-list plus every source host. */
export function allowedHosts(config: NewsConfig): string[] {
  return [...new Set([...config.fetchAllowList, ...config.sources.map((s) => hostOf(s.url))])];
}

/**
 * Drop items that are off-topic, stale, undated, from a blocked domain or
 * off the allow-list. The blocked list wins over the allow-list.
 */
export function filterItems(items: NewsItem[], config: NewsConfig, now: Date): FilterResult {
  const kept: NewsItem[] = [];
  const rejected: Rejection[] = [];
  const allow = allowedHosts(config);
  const oldest = now.getTime() - config.recencyHours * 3_600_000;
  const newest = now.getTime() + 3_600_000;
  for (const item of items) {
    const reject = (reason: string, detail?: string) =>
      rejected.push({ key: item.key, url: item.url, stage: "filter", reason, detail });
    const host = hostOf(item.url);
    const matched = matchKeywords(`${item.title} ${item.summary ?? ""}`, config.keywords);
    const time = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
    if (hostMatches(host, config.blockedDomains)) reject("blocked_domain", host);
    else if (!hostMatches(host, allow)) reject("host_not_allowed", host);
    else if (matched.length === 0) reject("off_topic");
    else if (Number.isNaN(time)) reject("no_date");
    else if (time < oldest) reject("stale", item.publishedAt);
    else if (time > newest) reject("future_date", item.publishedAt);
    else kept.push({ ...item, matched });
  }
  return { kept, rejected };
}
