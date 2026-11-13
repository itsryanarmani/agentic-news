# agentic-news

[Source and support](https://github.com/itsryanarmani/agentic-news) · MIT license

agentic-news turns niche news into short, sourced articles. It reads an allow-list of feeds, keeps fresh on-topic items, fetches each article safely, and writes a summary with the TL;DR first. A verifier rejects any summary that invents a fact or copies the source. Verified articles go to files, an HTTP endpoint, or an [agentic-publish](https://github.com/itsryanarmani/agentic-publish) queue.

Each site has one JSON config. The host runs agentic-news from cron or a CI job; the library has no timers.

## Install

The package is not on npm yet. Install it from GitHub; npm builds it on install:

```sh
npm install github:itsryanarmani/agentic-news
```

Requires Node.js 18 or later. The test suite needs Node.js 20.11 or later.

## Run your first site

The repository ships a fixture web on `example.test`, so this command runs with no network:

```sh
npx agentic-news run --config test/fixtures/config.json \
  --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief
```

It prints one line per item: one `would_publish` and ten rejections, each with a reason. Add `--live --out ./articles` to write the article. The full run, with a retry and an approval, is in [docs/e2e-transcript.md](docs/e2e-transcript.md).

From the SDK:

```js
import { readFile } from "node:fs/promises";
import { parseConfig, runNews, MemoryStateStore, fileTarget } from "agentic-news";

const config = parseConfig(JSON.parse(await readFile("site.json", "utf8")));
const report = await runNews(config, {
  fetch,
  now: () => new Date(),
  store: new MemoryStateStore(),
  targets: [fileTarget({ dir: "content/news" })],
}); // a dry run; pass { dryRun: false } as the third argument to publish
console.log(report.counts);
```

## How it works

```text
allow-listed feeds
  -> discover   RSS, Atom, or one official page
  -> filter     topic keywords, recency, blocked domains, fetch allow-list
  -> dedupe     canonical URL, content hash, near-identical title, state store
  -> fetch      robots.txt, size and time caps, no paywall or login pages
  -> summarize  your model, or the extractive default
  -> verify     facts, copying, TL;DR length, added context, attribution
  -> render     markdown with front matter, and JSON
  -> approve    sensitive sites only
  -> publish    files, HTTP, agentic-publish queue
```

Each stage is a small function with injected I/O: fetch, clock, state store, summarizer and approval hook. Every dropped item comes back with a stage and a reason code. [docs/failure-modes.md](docs/failure-modes.md) lists them.

## The config

```json
{
  "site": "example-niche",
  "keywords": ["heat pump", "rebate"],
  "sources": [{ "name": "Example Agency", "url": "https://agency.example.test/atom.xml" }],
  "fetchAllowList": ["agency.example.test"],
  "blockedDomains": [],
  "recencyHours": 48,
  "maxItemsPerDay": 5,
  "language": "en",
  "tone": "neutral",
  "sensitive": false,
  "requireContext": true,
  "tags": ["heat-pumps"],
  "context": [
    {
      "keyword": "rebate",
      "note": "One sentence of context in your own words.",
      "relatedLink": { "title": "Your guide", "url": "https://your-site.example/guide" }
    }
  ]
}
```

- `sources` is the allow-list. A source is a feed, or one official page with `"kind": "page"`.
- Articles come only from `fetchAllowList` and the source hosts. An entry matches that exact host, with or without a leading `www.`. Write `*.example.test` to allow its subdomains too.
- `blockedDomains` covers each domain and its subdomains, wins over both lists, and applies to every redirect hop.
- `sensitive: true` (health, legal, money, immigration) holds every item for a person to approve.
- `context` is your own text. "Why it matters" and the related link come from it. With `requireContext: true`, an item with no added context is refused.

## The verifier

The verifier checks every summary, whoever wrote it:

- Each number (digits or words such as "five"), currency amount, date and capitalized name must appear in the source. Names of two or more words must appear as the same phrase.
- The TL;DR may use only the source and its title and name. "Why it matters" may also use your own config text.
- The TL;DR has at most 2 sentences.
- No run of 8 or more source words appears outside one short quote of 30 words or fewer.
- With `requireContext`, "why it matters" has at least 8 words, and at least half of its content words are new.
- The article names its source and links to it on an allowed host.

The verifier returns findings and never rewrites text. A rejected item is not stored, so the next run can try it again.

## Use your own model

The summarizer is a function. The library reads no API key and names no vendor:

```js
const summarizer = async ({ article, matched, context, language, tone }) => {
  const draft = await yourModel(article.text, { language, tone, notes: context });
  return { tldr: draft.tldr, whyItMatters: draft.why, relatedLink: context[0]?.relatedLink };
};
await runNews(config, { ...io, summarizer }, { dryRun: false });
```

The default summarizer is extractive and deterministic. It quotes one key sentence with attribution, and it takes "why it matters" only from your `context` notes.

## Runtime surfaces

- **SDK:** `runNews`, `parseConfig`, each stage (`discover`, `filterItems`, `dedupe`, `fetchArticle`, `verifySummary`, `renderArticle`), targets (`fileTarget`, `httpTarget`, `queueTarget`), stores (`MemoryStateStore`, `FileStateStore`), `approveItem` and `fixtureFetch`.
- **CLI:** `check-config`, `run`, `pending`, `approve` and `mcp`. Run `npx agentic-news --help` for flags.
- **MCP:** `validate_config`, `verify_summary`, `run_news` and `list_pending`. There is no approve tool, because approval is a human step.

## Safety defaults

- The SDK, CLI and MCP server all default to a dry run.
- robots.txt is checked on every URL, feeds included, and on each redirect hop. A robots.txt that fails with 5xx means stay out.
- A redirect to a host off the allow-list is refused before that host is contacted.
- Every request has a size cap (1 MB) and a time cap (10 s). Paywall and login pages are refused.
- The HTTP target gets its token from a resolver you supply, sends an idempotency key and refuses redirects.
- The markdown body escapes HTML. Front matter and JSON hold raw text, so escape it in your templates.
- When one target fails after another succeeds, the run stores the receipts, and the next run calls only the failed target. A partial publish counts toward `maxItemsPerDay`. Give each target its own name, for example `httpTarget({ name: "cms", ... })`.
- Several sites can share one state file. Each run sees only its own site's records.
- Delivery is at least once. If the state store fails to save after a target took an item, the next run sends it again. Every target carries the stable post key (`post_key`, the `idempotency-key` header, the queue entry id), so receivers can drop repeats.

## Limits

- The feed parser reads RSS 2.0, RSS 1.0 and Atom with regular expressions. It is not a full XML parser.
- Name and date checks match patterns. They catch invented figures and names, not wrong meaning. Review sensitive items.
- The added-context check counts new words. A close synonym rewrite of the source can pass it.
- Text extraction keeps paragraphs, headings, list items and quotes from `<article>`, `<main>` or `<body>`.
- Labels in the rendered article ("TL;DR", "Why it matters") are in English.

## Status

Version 0.1.0 is not yet on npm, and interfaces can change. Report issues on [GitHub](https://github.com/itsryanarmani/agentic-news/issues).

## License

MIT.
