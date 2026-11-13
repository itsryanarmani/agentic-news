import { titleTokens } from "./keys.js";
import type { NewsItem, Rejection } from "./types.js";

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

export interface DedupeResult {
  kept: NewsItem[];
  rejected: Rejection[];
}

/**
 * Keep the first item of each story, in source order (the allow-list order is
 * the priority). Drops items already in the state store (seen keys), then
 * repeats by canonical URL, by content hash, and by near-identical title.
 */
export function dedupe(items: NewsItem[], seen: ReadonlySet<string> = new Set(), threshold = 0.8): DedupeResult {
  const kept: NewsItem[] = [];
  const rejected: Rejection[] = [];
  const urls = new Set<string>();
  const hashes = new Set<string>();
  const titles: Array<Set<string>> = [];
  const remember = (item: NewsItem, tokens: Set<string>) => {
    urls.add(item.canonicalUrl);
    hashes.add(item.contentHash);
    titles.push(tokens);
  };
  // Stories already handled count first, wherever they sit in the feed
  // order, so a copy under another URL never wins over the stored original.
  for (const item of items) {
    if (!seen.has(item.key)) continue;
    rejected.push({ key: item.key, url: item.url, stage: "dedupe", reason: "already_processed" });
    remember(item, titleTokens(item.title));
  }
  for (const item of items) {
    if (seen.has(item.key)) continue;
    const reject = (reason: string, detail?: string) =>
      rejected.push({ key: item.key, url: item.url, stage: "dedupe", reason, detail });
    const tokens = titleTokens(item.title);
    if (urls.has(item.canonicalUrl)) reject("duplicate_url", item.canonicalUrl);
    else if (hashes.has(item.contentHash)) reject("duplicate_content");
    else if (tokens.size >= 4 && titles.some((t) => jaccard(t, tokens) >= threshold)) reject("near_duplicate_title", item.title);
    else {
      kept.push(item);
      remember(item, tokens);
    }
  }
  return { kept, rejected };
}
