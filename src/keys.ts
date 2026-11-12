import { createHash } from "node:crypto";

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid)$/i;

/** Canonical form: https, no www, no fragment, no tracking params, sorted query, no trailing slash. */
export function canonicalUrl(url: string): string {
  const u = new URL(url);
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(kept).toString();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable 16-hex key per canonical URL. Hosts prefix it with the site id. */
export function itemKey(canonical: string): string {
  return sha256(canonical).slice(0, 16);
}

const STOP = new Set("the a an and or of to in on for with at by from as is are was were be its it this that new says said".split(" "));

export function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);
}

export function contentHash(title: string, summary = ""): string {
  return sha256(`${[...titleTokens(title)].sort().join(" ")}|${summary.toLowerCase().replace(/\s+/g, " ").trim()}`);
}
