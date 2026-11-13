import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RenderedArticle } from "./render.js";
import { splitSentences } from "./summarize.js";
import { StageError, type FetchLike } from "./types.js";

export interface Receipt {
  target: string;
  postKey: string;
  id: string;
  at: string;
  detail?: string;
}

/** A place a rendered article goes. publish throws on failure; it never reports false success. */
export interface PublishTarget {
  readonly name: string;
  publish(article: RenderedArticle, at: Date): Promise<Receipt>;
}

export interface FileTargetOptions {
  dir: string;
  /** Write markdown, JSON or both. Default both. */
  formats?: Array<"md" | "json">;
}

/** Write <dir>/<slug>.md and <dir>/<slug>.json. Rewriting the same slug is safe. */
export function fileTarget(options: FileTargetOptions): PublishTarget {
  const formats = options.formats ?? ["md", "json"];
  return {
    name: "file",
    async publish(article, at) {
      await mkdir(options.dir, { recursive: true });
      const written: string[] = [];
      for (const format of formats) {
        const path = join(options.dir, `${article.data.slug}.${format}`);
        await writeFile(path, format === "md" ? article.markdown : `${JSON.stringify(article.data, null, 2)}\n`, "utf8");
        written.push(path);
      }
      return { target: "file", postKey: article.data.postKey, id: article.data.slug, at: at.toISOString(), detail: written.join(", ") };
    },
  };
}

export interface HttpTargetOptions {
  endpoint: string;
  /** Default "http". Give each HTTP target its own name when you use more than one. */
  name?: string;
  /** The host resolves the token (env, vault, secret store). The library reads none. */
  token: () => string | Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * POST { article, markdown } as JSON with a bearer token and an
 * idempotency key equal to the post key. Redirects are an error, so the
 * token is never sent to a second URL.
 */
export function httpTarget(options: HttpTargetOptions): PublishTarget {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    name: options.name ?? "http",
    async publish(article, at) {
      const token = await options.token();
      if (!token) throw new StageError("missing_token", "the token resolver returned nothing");
      let response: Response;
      try {
        response = await fetch(options.endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": article.data.postKey,
          },
          body: JSON.stringify({ article: article.data, markdown: article.markdown }),
        });
      } catch (error) {
        throw new StageError("http_target_failed", String(error));
      }
      if (!response.ok) throw new StageError("http_target_failed", `status ${response.status}`);
      const body = (await response.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : article.data.postKey;
      return { target: options.name ?? "http", postKey: article.data.postKey, id, at: at.toISOString(), detail: `status ${response.status}` };
    },
  };
}

/** The agentic-publish SocialPost and QueuedPost shapes, mirrored so no runtime dependency is needed. */
export type Channel = "x" | "linkedin" | "tiktok" | "instagram";
export interface SocialPost { text: string; targets: Channel[]; link?: string; brand?: string }
export interface QueuedPost { id: string; brand: string; post: SocialPost; enqueuedAt: string; attempts: number }
export interface QueueStoreLike {
  load(): QueuedPost[] | Promise<QueuedPost[]>;
  save(items: QueuedPost[]): void | Promise<void>;
}

/**
 * Short social text: headline, source, one sentence of the host's own
 * context when it fits, then the link. Never over maxChars.
 */
export function socialText(article: RenderedArticle, link: string, maxChars = 300): string {
  const { title, source_name: source, why_it_matters: why } = article.data;
  const tail = `\n\n${link}`;
  const head = `${title} (via ${source})`;
  const extra = splitSentences(why)[0];
  if (extra && head.length + extra.length + 2 + tail.length <= maxChars) return `${head}\n\n${extra}${tail}`;
  if (head.length + tail.length <= maxChars) return `${head}${tail}`;
  // Cut the headline, never the attribution or the link.
  const via = ` (via ${source})`;
  const room = maxChars - tail.length - via.length - 1;
  if (room < 20) throw new StageError("link_too_long", link);
  return `${title.slice(0, room).replace(/\s+\S*$/, "")}…${via}${tail}`;
}

export interface QueueTargetOptions {
  brand: string;
  channels: Channel[];
  store: QueueStoreLike;
  /** Link for the post. Default: the source URL. Hosts usually pass their own article URL. */
  linkFor?: (article: RenderedArticle) => string;
  maxChars?: number;
}

/** Append one agentic-publish queue entry per article. The post key is the entry id, so a retry adds nothing. */
export function queueTarget(options: QueueTargetOptions): PublishTarget {
  return {
    name: "agentic-publish-queue",
    async publish(article, at) {
      const id = article.data.postKey;
      const items = await options.store.load();
      if (!items.some((item) => item.id === id)) {
        const link = options.linkFor?.(article) ?? article.data.source_url;
        const post: SocialPost = { text: socialText(article, link, options.maxChars), targets: options.channels, link, brand: options.brand };
        await options.store.save([...items, { id, brand: options.brand, post, enqueuedAt: at.toISOString(), attempts: 0 }]);
      }
      return { target: "agentic-publish-queue", postKey: id, id, at: at.toISOString() };
    },
  };
}

/** A JSON-array queue file in the agentic-publish FileQueueStore format. */
export function jsonQueueFile(path: string): QueueStoreLike {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!Array.isArray(parsed)) throw new StageError("bad_queue_file", `${path} must hold a JSON array`);
        return parsed as QueuedPost[];
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return [];
        throw error;
      }
    },
    async save(items) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    },
  };
}
