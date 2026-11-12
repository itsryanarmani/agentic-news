import type { SourceArticle } from "./article.js";
import { allowedHosts } from "./filter.js";
import { hostMatches, hostOf } from "./http.js";
import type { Summary } from "./summarize.js";
import type { NewsConfig } from "./types.js";
import type { Finding } from "./verify.js";

/** The JSON form. The markdown front matter carries the same fields. */
export interface ArticleData {
  postKey: string;
  slug: string;
  lang: string;
  title: string;
  date: string;
  source_url: string;
  source_name: string;
  tags: string[];
  tldr: string;
  why_it_matters: string;
  related_link?: { title: string; url: string };
}

export interface RenderedArticle {
  data: ArticleData;
  markdown: string;
}

export function slugify(text: string, max = 60): string {
  const slug = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug.length <= max) return slug || "item";
  const cut = slug.slice(0, max);
  return cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut;
}

function link(text: string, url: string): string {
  return `[${text.replace(/[[\]]/g, "\\$&")}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

/** Attribution rules: a named source, a link on an allowed host, and both in the body. */
export function checkAttribution(rendered: RenderedArticle, config: NewsConfig): Finding[] {
  const { data, markdown } = rendered;
  const found: Finding[] = [];
  if (!data.source_name.trim()) found.push({ reason: "missing_attribution", detail: "no source name" });
  let host = "";
  try {
    host = hostOf(data.source_url);
  } catch {
    found.push({ reason: "missing_source_link", detail: data.source_url });
  }
  if (host && !hostMatches(host, allowedHosts(config))) found.push({ reason: "source_link_not_allowed", detail: host });
  if (!markdown.includes(link(data.source_name, data.source_url))) {
    found.push({ reason: "missing_source_link", detail: "body has no source link" });
  }
  return found;
}

/**
 * Render a verified summary as markdown with front matter, plus JSON.
 * Call verifySummary first; this function checks only attribution.
 */
export function renderArticle(article: SourceArticle, summary: Summary, config: NewsConfig, matched: string[], now: Date): RenderedArticle {
  const date = article.publishedAt ?? now.toISOString();
  const data: ArticleData = {
    postKey: `${config.site}:${article.key}`,
    slug: `${date.slice(0, 10)}-${slugify(article.title)}`,
    lang: config.language,
    title: article.title,
    date,
    source_url: article.url,
    source_name: article.sourceName,
    tags: [...new Set([...config.tags, ...matched.map((m) => slugify(m))])],
    tldr: summary.tldr.trim(),
    why_it_matters: summary.whyItMatters.trim(),
    ...(summary.relatedLink ? { related_link: summary.relatedLink } : {}),
  };
  const front = {
    title: data.title, date: data.date, lang: data.lang, source_url: data.source_url,
    source_name: data.source_name, tags: data.tags, tldr: data.tldr, post_key: data.postKey,
  };
  const lines = ["---", ...Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""];
  lines.push(`**TL;DR:** ${data.tldr}`, "");
  if (data.why_it_matters) lines.push("## Why it matters", "", data.why_it_matters, "");
  if (data.related_link) lines.push(`Related: ${link(data.related_link.title, data.related_link.url)}`, "");
  lines.push(`Source: ${link(data.source_name, data.source_url)}, published ${date.slice(0, 10)}.`, "");
  return { data, markdown: lines.join("\n") };
}
