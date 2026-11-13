// Shared shapes. Every stage takes plain data and injected I/O, and
// returns plain data, so a host can run, test or replace one stage.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceFeed {
  name: string;
  url: string;
  /** rss and atom are feeds; page is one official page read as one item. */
  kind?: "feed" | "page";
}

/** Host-supplied context. The library never invents context. */
export interface ContextNote {
  keyword: string;
  note: string;
  relatedLink?: { title: string; url: string };
}

export interface NewsConfig {
  /** Stable site id. It prefixes every post key. */
  site: string;
  siteName?: string;
  language: string;
  tone: "neutral" | "plain" | "formal";
  keywords: string[];
  sources: SourceFeed[];
  /** Hosts the library may fetch articles from. Source hosts are always allowed. */
  fetchAllowList: string[];
  blockedDomains: string[];
  recencyHours: number;
  maxItemsPerDay: number;
  /** Health, legal, money, immigration: every item needs a human approval. */
  sensitive: boolean;
  /** Refuse an article that adds no context to the source. */
  requireContext: boolean;
  context: ContextNote[];
  tags: string[];
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
}

export interface NewsItem {
  key: string;
  title: string;
  url: string;
  canonicalUrl: string;
  sourceName: string;
  feedUrl: string;
  publishedAt?: string;
  summary?: string;
  contentHash: string;
  matched: string[];
}

export type Stage =
  | "discover" | "filter" | "dedupe" | "fetch" | "summarize"
  | "verify" | "approve" | "publish";

export interface Rejection {
  key: string;
  url: string;
  stage: Stage;
  reason: string;
  detail?: string;
}

export interface SourceError {
  source: string;
  url: string;
  reason: string;
  detail?: string;
}

/** Thrown by a stage that cannot go on for one item or one source. */
export class StageError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "StageError";
  }
}
