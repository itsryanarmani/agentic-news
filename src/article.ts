import { decodeText } from "./feed.js";
import { allowedHosts } from "./filter.js";
import { boundedGet, hostOf, type GetOptions } from "./http.js";
import { StageError, type FetchLike, type NewsConfig, type NewsItem } from "./types.js";

export interface SourceArticle {
  key: string;
  url: string;
  title: string;
  sourceName: string;
  publishedAt?: string;
  /** Plain text, paragraphs split by blank lines. Scripts and page chrome removed. */
  text: string;
}

interface RobotsRule { allow: boolean; pattern: string }
/** Parsed robots.txt rules per origin, shared across one run. */
export type RobotsCache = Map<string, RobotsRule[] | "deny-all">;

/**
 * Rules for our agent token, else for "*". Every group that names the agent
 * counts, merged, so a second group cannot be skipped. Empty means all paths allowed.
 */
export function parseRobots(text: string, agentToken: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!match) continue;
    const [, field, value] = match;
    if (field.toLowerCase() === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && value) {
      // Rules and paths are both decoded, so %C3%A9 and é compare equal.
      current.rules.push({ allow: field.toLowerCase() === "allow", pattern: decodePath(value) });
    }
  }
  const token = agentToken.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Longest matching rule wins; allow wins a tie. Supports * and $. */
export function robotsAllows(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    const source = rule.pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (!new RegExp(`^${source}`).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** Decode %XX escapes so /%70rivate is matched as /private. Bad escapes stay as they are. */
function decodePath(path: string): string {
  return path.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      // An encoded * or $ stays literal, so it never becomes a robots wildcard.
      return decodeURIComponent(m).replace(/\*/g, "%2A").replace(/\$/g, "%24");
    } catch {
      return m;
    }
  });
}

/** Throws robots_disallowed or robots_unavailable. Caches rules per origin. */
export async function checkRobots(url: string, get: GetOptions, cache: RobotsCache): Promise<void> {
  const { origin, pathname, search } = new URL(url);
  if (!cache.has(origin)) {
    try {
      const got = await boundedGet(`${origin}/robots.txt`, { ...get, accept: "text/plain", allowHosts: [hostOf(url)], maxRedirects: 0 });
      // 4xx means no rules. 5xx means the site is unsure, so stay out.
      if (got.status >= 500) cache.set(origin, "deny-all");
      else cache.set(origin, got.status >= 400 ? [] : parseRobots(got.body, get.userAgent.split("/")[0]));
    } catch {
      cache.set(origin, "deny-all");
    }
  }
  const rules = cache.get(origin);
  if (rules === "deny-all") throw new StageError("robots_unavailable", origin);
  // In a path, a literal * or $ is just a character, so write it the way rules write it (%2A, %24).
  const path = decodePath(pathname + search).replace(/\*/g, "%2A").replace(/\$/g, "%24");
  if (!robotsAllows(rules ?? [], path)) throw new StageError("robots_disallowed", pathname);
}

const PAYWALL = [/"isAccessibleForFree"\s*:\s*"?false/i, /\bclass\s*=\s*["']?[^"'>]*\bpaywall\b/i, /subscribe to (continue|keep) reading/i, /for subscribers only/i];
const LOGIN = [/<input\b[^>]*\btype\s*=\s*["']?password\b/i, /(sign|log) in to (continue|read)/i];

/** Strip scripts, styles and page chrome; keep the article body text. */
export function extractText(html: string): string {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // A closing tag may carry spaces (</script >); an unclosed one drops the rest of the page.
    .replace(/<(script|style|noscript|template|iframe|svg|nav|header|footer|aside|form)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const scope = clean.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    ?? clean.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    ?? clean.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
    ?? clean;
  const blocks = [...scope.matchAll(/<(p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => decodeText(m[2]));
  return blocks.filter(Boolean).join("\n\n");
}

export interface FetchArticleOptions {
  fetch: FetchLike;
  robots?: RobotsCache;
  /** Fewer characters than this is a thin source. Default 300. */
  minChars?: number;
}

/**
 * Fetch one item's article. Allowed hosts only, robots.txt first, redirects
 * held to the allow-list, size and time caps, no paywall or login pages.
 * Throws StageError with the reason; never returns a partial page.
 */
export async function fetchArticle(item: NewsItem, config: NewsConfig, options: FetchArticleOptions): Promise<SourceArticle> {
  const robots = options.robots ?? new Map();
  const get: GetOptions = {
    fetch: options.fetch,
    allowHosts: allowedHosts(config),
    blockHosts: config.blockedDomains,
    maxBytes: config.maxBytes,
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent,
    accept: "text/html",
  };
  const got = await boundedGet(item.url, {
    ...get,
    maxRedirects: 3,
    beforeRequest: (url) => checkRobots(url, get, robots),
  });
  return toArticle(item, got.url, got.status, got.contentType, got.body, options.minChars ?? 300);
}

function toArticle(item: NewsItem, url: string, status: number, type: string, body: string, minChars: number): SourceArticle {
  if (status === 401 || status === 407) throw new StageError("login_required", `status ${status}`);
  if (status === 402) throw new StageError("paywall", "status 402");
  if (status >= 400) throw new StageError("http_error", `status ${status}`);
  if (type && !/html|text\/plain/i.test(type)) throw new StageError("not_html", type);
  if (LOGIN.some((re) => re.test(body))) throw new StageError("login_required");
  if (PAYWALL.some((re) => re.test(body))) throw new StageError("paywall");
  const text = extractText(body);
  if (text.length < minChars) throw new StageError("thin_source", `${text.length} chars`);
  return { key: item.key, url, title: item.title, sourceName: item.sourceName, publishedAt: item.publishedAt, text };
}
