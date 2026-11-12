import type { FetchLike } from "./types.js";

/** One canned response. error makes the fetch reject, like a host that is down. */
export interface FixtureRoute {
  status?: number;
  body?: string;
  file?: string;
  headers?: Record<string, string>;
  error?: "network" | "timeout";
}

export interface FixtureFetch {
  fetch: FetchLike;
  /** Every URL requested, in order. Tests read it to prove a host was never contacted. */
  requests: string[];
}

/**
 * A fetch that serves canned responses and never touches the network. An
 * unknown URL gets a 404. readFile resolves route.file (the CLI passes a
 * reader relative to the manifest).
 */
export function fixtureFetch(
  routes: Record<string, FixtureRoute>,
  readFile: (path: string) => string = () => {
    throw new Error("fixture route uses file but no readFile was given");
  },
): FixtureFetch {
  const requests: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    requests.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    if (route.error === "network") throw new TypeError(`fetch failed: ${url}`);
    if (route.error === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const body = route.file ? readFile(route.file) : route.body ?? "";
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  };
  return { fetch, requests };
}
