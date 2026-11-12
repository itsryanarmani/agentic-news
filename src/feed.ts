import { StageError } from "./types.js";

export interface FeedEntry {
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode XML/HTML entities, unwrap CDATA, drop tags, fold spaces. */
export function decodeText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function count(xml: string, pattern: RegExp): number {
  return xml.match(pattern)?.length ?? 0;
}

function child(block: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match) return decodeText(match[1]);
  }
  return undefined;
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((attrs) => !/rel=/.test(attrs) || /rel=["']alternate["']/.test(attrs));
  return pick?.match(/href=["']([^"']+)["']/)?.[1];
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * Parse RSS 2.0, RSS 1.0 (RDF) or Atom. Throws StageError("malformed_feed")
 * when the root is missing or item tags do not balance, so a broken feed is
 * reported instead of read as an empty one.
 */
export function parseFeed(xml: string, feedUrl: string): FeedEntry[] {
  const root = xml.match(/<(rss|feed|rdf:RDF)\b/i)?.[1];
  if (!root) throw new StageError("malformed_feed", "no rss, feed or rdf:RDF root");
  if (!new RegExp(`</${root}\\s*>`, "i").test(xml)) throw new StageError("malformed_feed", `unclosed <${root}>`);
  const tag = root.toLowerCase() === "feed" ? "entry" : "item";
  const opens = count(xml, new RegExp(`<${tag}[\\s>]`, "gi"));
  const closes = count(xml, new RegExp(`</${tag}>`, "gi"));
  if (opens !== closes) throw new StageError("malformed_feed", `${opens} <${tag}> opened, ${closes} closed`);

  const blocks = [...xml.matchAll(new RegExp(`<${tag}[\\s>]([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]);
  const entries: FeedEntry[] = [];
  for (const block of blocks) {
    const title = child(block, ["title"]);
    const rawLink = tag === "entry" ? atomLink(block) : child(block, ["link"]) ?? child(block, ["guid"]);
    if (!title || !rawLink) continue;
    let url: string;
    try {
      url = new URL(decodeText(rawLink), feedUrl).toString();
    } catch {
      continue;
    }
    entries.push({
      title,
      url,
      publishedAt: isoDate(child(block, ["pubDate", "published", "updated", "dc:date"])),
      summary: child(block, ["description", "summary", "content"]),
    });
  }
  return entries;
}

/** Read one official HTML page as one entry (title and published time from meta tags). */
export function parsePage(html: string, pageUrl: string): FeedEntry[] {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1];
  const title = meta("og:title") ?? child(html, ["title"]);
  if (!title) throw new StageError("malformed_page", "no title");
  return [{
    title: decodeText(title),
    url: pageUrl,
    publishedAt: isoDate(meta("article:published_time") ?? meta("date") ?? meta("dcterms.modified")),
    summary: meta("description") ? decodeText(meta("description") as string) : undefined,
  }];
}
