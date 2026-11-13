---
name: agentic-news
description: Turn niche news into short, sourced, verified articles with a TL;DR first. Keywords: news,rss,atom,summarization,fact-check,content-pipeline,agentic-suite,cli,mcp.
---

# agentic-news

Turn niche news into short, sourced, verified articles.

## Use the SDK

```js
import { parseConfig, runNews, MemoryStateStore } from "agentic-news";

const report = await runNews(parseConfig(siteJson), {
  fetch, now: () => new Date(), store: new MemoryStateStore(), targets: [],
});
```

## Use the CLI

```sh
agentic-news run --config site.json --brief
agentic-news run --config site.json --live --out content/news
agentic-news pending --state .agentic-news/<site>-state.json
```

## Use the MCP server

Start it with `agentic-news mcp`. Call `run_news` as a dry run first.

## Rules

- Dry run first. Ask the user before a live run.
- Report each rejection reason. Do not loosen the config to force a publish.
- A person approves sensitive items with the CLI.
