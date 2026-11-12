# agentic-news end-to-end transcript

Fixture web only (example.test). Clock fixed at 2026-11-12T12:00:00Z. Regenerate with `npm run e2e`.

## Check the config

```console
$ agentic-news check-config --config test/fixtures/config.json
{"ok":true,"site":"example-niche","sources":4,"sensitive":false}
[exit 0]
```

## Dry run (default): nothing is published or stored

```console
$ agentic-news run --config test/fixtures/config.json --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief --state out/e2e/state.json
dry run example-niche: {"rejected":10,"would_publish":1}
  source_error     network_error            https://down.example.test/feed.xml
  source_error     malformed_feed           https://broken.example.test/feed.xml
  rejected         off_topic                https://news.example.test/2026/11/bakery
  rejected         stale                    https://news.example.test/2024/01/rebate-program
  rejected         blocked_domain           https://blocked.example.test/rebate-scam
  rejected         host_not_allowed         https://partner.example.test/guide
  rejected         no_date                  https://news.example.test/2026/11/deadline
  rejected         duplicate_url            https://news.example.test/2026/11/heat-pump-rebate-renters/
  rejected         near_duplicate_title     https://agency.example.test/notices/rebate-renters
  would_publish                             https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss
  rejected         redirect_off_allow_list  https://news.example.test/2026/11/installer-backlog
  rejected         paywall                  https://news.example.test/2026/11/members-only
  rejected         no_added_context         https://agency.example.test/notices/efficiency-standard
[exit 0]
```

## Live run: write files and queue a social post

```console
$ agentic-news run --config test/fixtures/config.json --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief --state out/e2e/state.json --live --out out/e2e/articles --queue out/e2e/queue.json --channels x,linkedin --link-base https://directory.example.test/news
live example-niche: {"rejected":10,"published":1}
  source_error     network_error            https://down.example.test/feed.xml
  source_error     malformed_feed           https://broken.example.test/feed.xml
  rejected         off_topic                https://news.example.test/2026/11/bakery
  rejected         stale                    https://news.example.test/2024/01/rebate-program
  rejected         blocked_domain           https://blocked.example.test/rebate-scam
  rejected         host_not_allowed         https://partner.example.test/guide
  rejected         no_date                  https://news.example.test/2026/11/deadline
  rejected         duplicate_url            https://news.example.test/2026/11/heat-pump-rebate-renters/
  rejected         near_duplicate_title     https://agency.example.test/notices/rebate-renters
  published                                 https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss
  rejected         redirect_off_allow_list  https://news.example.test/2026/11/installer-backlog
  rejected         paywall                  https://news.example.test/2026/11/members-only
  rejected         no_added_context         https://agency.example.test/notices/efficiency-standard
[exit 0]
```

## Published article

```markdown
---
title: "Province expands heat pump rebate to renters"
date: "2026-11-12T08:00:00.000Z"
lang: "en"
source_url: "https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss"
source_name: "Example News"
tags: ["heat-pumps","heat-pump","rebate"]
tldr: "Example News reports: \"The Example Province energy ministry said on November 12, 2026 that renters can now apply for the heat pump rebate.\""
post_key: "example-niche:de8bc83451328b6f"
---

**TL;DR:** Example News reports: "The Example Province energy ministry said on November 12, 2026 that renters can now apply for the heat pump rebate."

## Why it matters

Our directory lists installers who handle rebate paperwork, so check the installer pages before you apply.

Related: [How rebates work](https://directory.example.test/guides/rebates)

Source: [Example News](https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss), published 2026-11-12.
```

## Queue entry for agentic-publish

```json
[
  {
    "id": "example-niche:de8bc83451328b6f",
    "brand": "example-niche",
    "post": {
      "text": "Province expands heat pump rebate to renters (via Example News)\n\nOur directory lists installers who handle rebate paperwork, so check the installer pages before you apply.\n\nhttps://directory.example.test/news/2026-11-12-province-expands-heat-pump-rebate-to-renters",
      "targets": [
        "x",
        "linkedin"
      ],
      "link": "https://directory.example.test/news/2026-11-12-province-expands-heat-pump-rebate-to-renters",
      "brand": "example-niche"
    },
    "enqueuedAt": "2026-11-12T12:00:00.000Z",
    "attempts": 0
  }
]
```

## Retried run (cron retry): nothing is published twice

```console
$ agentic-news run --config test/fixtures/config.json --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief --state out/e2e/state.json --live --out out/e2e/articles --queue out/e2e/queue.json --channels x,linkedin
live example-niche: {"rejected":9,"already_published":1}
  source_error     network_error            https://down.example.test/feed.xml
  source_error     malformed_feed           https://broken.example.test/feed.xml
  rejected         off_topic                https://news.example.test/2026/11/bakery
  rejected         stale                    https://news.example.test/2024/01/rebate-program
  rejected         blocked_domain           https://blocked.example.test/rebate-scam
  rejected         host_not_allowed         https://partner.example.test/guide
  rejected         no_date                  https://news.example.test/2026/11/deadline
  already_published                          https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss
  rejected         duplicate_content        https://agency.example.test/notices/rebate-renters
  rejected         redirect_off_allow_list  https://news.example.test/2026/11/installer-backlog
  rejected         paywall                  https://news.example.test/2026/11/members-only
  rejected         no_added_context         https://agency.example.test/notices/efficiency-standard
[exit 0]
```

## Sensitive niche: the item waits for approval

```console
$ agentic-news run --config test/fixtures/config-sensitive.json --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief --state out/e2e/sensitive.json --live --out out/e2e/sensitive
live example-health: {"rejected":10,"pending_approval":1}
  source_error     network_error            https://down.example.test/feed.xml
  source_error     malformed_feed           https://broken.example.test/feed.xml
  rejected         off_topic                https://news.example.test/2026/11/bakery
  rejected         stale                    https://news.example.test/2024/01/rebate-program
  rejected         blocked_domain           https://blocked.example.test/rebate-scam
  rejected         host_not_allowed         https://partner.example.test/guide
  rejected         no_date                  https://news.example.test/2026/11/deadline
  rejected         duplicate_url            https://news.example.test/2026/11/heat-pump-rebate-renters/
  rejected         near_duplicate_title     https://agency.example.test/notices/rebate-renters
  pending_approval needs_approval           https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss
  rejected         redirect_off_allow_list  https://news.example.test/2026/11/installer-backlog
  rejected         paywall                  https://news.example.test/2026/11/members-only
  rejected         no_added_context         https://agency.example.test/notices/efficiency-standard
[exit 0]
```

## List pending items

```console
$ agentic-news pending --state out/e2e/sensitive.json
[
  {
    "postKey": "example-health:de8bc83451328b6f",
    "url": "https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss",
    "title": "Province expands heat pump rebate to renters",
    "tldr": "Example News reports: \"The Example Province energy ministry said on November 12, 2026 that renters can now apply for the heat pump rebate.\""
  }
]
[exit 0]
```

## Approve the item

```console
$ agentic-news approve --state out/e2e/sensitive.json --key example-health:de8bc83451328b6f --by editor
{"approved":"example-health:de8bc83451328b6f","by":"editor"}
[exit 0]
```

## Next run publishes the approved item

```console
$ agentic-news run --config test/fixtures/config-sensitive.json --fixtures test/fixtures/web.json --now 2026-11-12T12:00:00Z --brief --state out/e2e/sensitive.json --live --out out/e2e/sensitive
live example-health: {"published":1,"rejected":9}
  source_error     network_error            https://down.example.test/feed.xml
  source_error     malformed_feed           https://broken.example.test/feed.xml
  published                                 https://news.example.test/2026/11/heat-pump-rebate-renters?utm_source=rss
  rejected         off_topic                https://news.example.test/2026/11/bakery
  rejected         stale                    https://news.example.test/2024/01/rebate-program
  rejected         blocked_domain           https://blocked.example.test/rebate-scam
  rejected         host_not_allowed         https://partner.example.test/guide
  rejected         no_date                  https://news.example.test/2026/11/deadline
  rejected         duplicate_content        https://agency.example.test/notices/rebate-renters
  rejected         redirect_off_allow_list  https://news.example.test/2026/11/installer-backlog
  rejected         paywall                  https://news.example.test/2026/11/members-only
  rejected         no_added_context         https://agency.example.test/notices/efficiency-standard
[exit 0]
```

## A bad config is refused with every problem

```console
$ agentic-news check-config --config package.json
invalid config: site must be a lowercase id (a-z, 0-9, -); sources must be a non-empty list
[exit 2]
```
