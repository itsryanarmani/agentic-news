import { StageError, type FetchLike } from "./types.js";

/** Lowercase host without a leading www. */
export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** True when host is a listed domain or a subdomain of one. */
export function hostMatches(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

export interface GetOptions {
  fetch: FetchLike;
  allowHosts: string[];
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
  accept?: string;
  maxRedirects?: number;
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
    if (!hostMatches(hostOf(current), options.allowHosts)) {
      throw new StageError(hop === 0 ? "host_not_allowed" : "redirect_off_allow_list", hostOf(current));
    }
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
    const body = await readCapped(response, options.maxBytes);
    return { url: current, status: response.status, contentType: response.headers.get("content-type") ?? "", body };
  }
  throw new StageError("too_many_redirects", url);
}
