import { StageError, type FetchLike } from "./types.js";

/** Lowercase host without a leading www. */
export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Allow-list match: the exact host only. "*.example.test" allows every
 * subdomain of example.test (and example.test itself), so a wide allow is
 * always written on purpose.
 */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = bare(host);
  return allow.some((entry) => {
    const d = bare(entry);
    if (!d.startsWith("*.")) return h === d;
    const root = d.slice(2);
    return h === root || h.endsWith(`.${root}`);
  });
}

/** Block-list match: the listed domain and every subdomain of it. */
export function hostBlocked(host: string, block: string[]): boolean {
  const h = bare(host);
  return block.some((entry) => {
    const d = bare(entry).replace(/^\*\./, "");
    return h === d || h.endsWith(`.${d}`);
  });
}

export interface GetOptions {
  fetch: FetchLike;
  allowHosts: string[];
  /** Checked on every hop; wins over allowHosts. */
  blockHosts?: string[];
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
  accept?: string;
  maxRedirects?: number;
  /** Runs before each request, after the host check (for example, robots.txt). */
  beforeRequest?: (url: string) => Promise<void>;
}

export interface GetResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new StageError("too_large", `${declared} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new StageError("too_large", `over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * GET one URL with a time cap, a size cap and manual redirects. A redirect
 * is followed only when its target host is on allowHosts, so the library
 * never sends a request to a host the config did not allow.
 */
export async function boundedGet(url: string, options: GetOptions): Promise<GetResult> {
  let current = url;
  const maxRedirects = options.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const protocol = new URL(current).protocol;
    if (protocol !== "https:" && protocol !== "http:") throw new StageError("bad_url", current);
    if (hostBlocked(hostOf(current), options.blockHosts ?? [])) {
      throw new StageError(hop === 0 ? "blocked_domain" : "redirect_off_allow_list", hostOf(current));
    }
    if (!hostAllowed(hostOf(current), options.allowHosts)) {
      throw new StageError(hop === 0 ? "host_not_allowed" : "redirect_off_allow_list", hostOf(current));
    }
    await options.beforeRequest?.(current);
    let response: Response;
    try {
      response = await options.fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "user-agent": options.userAgent, accept: options.accept ?? "*/*" },
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new StageError("timeout", current);
      throw new StageError("network_error", String(error));
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new StageError("bad_redirect", `status ${response.status} without location`);
      current = new URL(location, current).toString();
      continue;
    }
    let body: string;
    try {
      body = await readCapped(response, options.maxBytes);
    } catch (error) {
      if (error instanceof StageError) throw error;
      const name = (error as { name?: string })?.name;
      // A body that stalls after the headers hits the same time cap.
      throw new StageError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error", String(error));
    }
    return { url: current, status: response.status, contentType: response.headers.get("content-type") ?? "", body };
  }
  throw new StageError("too_many_redirects", url);
}
