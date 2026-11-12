import type { ContextNote, NewsConfig, SourceFeed } from "./types.js";

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid config: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const DEFAULTS = {
  language: "en",
  tone: "neutral" as const,
  fetchAllowList: [] as string[],
  blockedDomains: [] as string[],
  recencyHours: 48,
  maxItemsPerDay: 5,
  sensitive: false,
  requireContext: true,
  context: [] as ContextNote[],
  tags: [] as string[],
  maxBytes: 1_000_000,
  timeoutMs: 10_000,
  userAgent: "agentic-news/0.1 (+https://github.com/itsryanarmani/agentic-news)",
};

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "");
}

/** Validate a parsed JSON config and fill defaults. Lists every problem at once. */
export function parseConfig(input: unknown): NewsConfig {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ConfigError(["config must be a JSON object"]);
  }
  const raw = input as Record<string, unknown>;
  const merged = { ...DEFAULTS, ...raw } as Record<string, unknown>;

  if (typeof raw.site !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw.site)) {
    problems.push("site must be a lowercase id (a-z, 0-9, -)");
  }
  if (!strings(raw.keywords) || raw.keywords.length === 0) {
    problems.push("keywords must be a non-empty list of strings");
  }
  const sources = raw.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    problems.push("sources must be a non-empty list");
  } else {
    sources.forEach((s: Partial<SourceFeed>, i) => {
      if (typeof s?.name !== "string" || !s.name.trim()) problems.push(`sources[${i}].name is required`);
      if (!isHttpUrl(s?.url)) problems.push(`sources[${i}].url must be an http(s) URL`);
      if (s?.kind !== undefined && s.kind !== "feed" && s.kind !== "page") {
        problems.push(`sources[${i}].kind must be feed or page`);
      }
    });
  }
  for (const key of ["fetchAllowList", "blockedDomains", "tags"] as const) {
    if (!Array.isArray(merged[key]) || !(merged[key] as unknown[]).every((v) => typeof v === "string")) {
      problems.push(`${key} must be a list of strings`);
    }
  }
  for (const key of ["recencyHours", "maxItemsPerDay", "maxBytes", "timeoutMs"] as const) {
    const n = merged[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) problems.push(`${key} must be a positive number`);
  }
  for (const key of ["sensitive", "requireContext"] as const) {
    if (typeof merged[key] !== "boolean") problems.push(`${key} must be true or false`);
  }
  if (!["neutral", "plain", "formal"].includes(String(merged.tone))) {
    problems.push("tone must be neutral, plain or formal");
  }
  if (!Array.isArray(merged.context)) {
    problems.push("context must be a list");
  } else {
    (merged.context as Partial<ContextNote>[]).forEach((c, i) => {
      if (typeof c?.keyword !== "string" || typeof c?.note !== "string") {
        problems.push(`context[${i}] needs keyword and note strings`);
      }
      if (c?.relatedLink && (!isHttpUrl(c.relatedLink.url) || typeof c.relatedLink.title !== "string")) {
        problems.push(`context[${i}].relatedLink needs a title and an http(s) url`);
      }
    });
  }
  if (problems.length) throw new ConfigError(problems);

  const lower = (list: string[]) => list.map((h) => h.toLowerCase().replace(/^www\./, ""));
  return {
    ...(merged as unknown as NewsConfig),
    fetchAllowList: lower(merged.fetchAllowList as string[]),
    blockedDomains: lower(merged.blockedDomains as string[]),
    sources: (sources as SourceFeed[]).map((s) => ({ name: s.name, url: s.url, kind: s.kind ?? "feed" })),
  };
}
