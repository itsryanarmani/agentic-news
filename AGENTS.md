# agentic-news agent guide

Turn niche news into short, sourced, verified articles.

## Mental model

A site config goes in. A run report comes out: one status per item, and a
stage and reasons for each rejection. The SDK, CLI and MCP server share one core.

## MCP tools

| Tool | Use it for |
| --- | --- |
| validate_config | Check a site config. Read every problem. |
| verify_summary | Check your own TL;DR and context against the source. |
| run_news | Run one site. A dry run unless live and approved are true. |
| list_pending | Show items that wait for a person to approve them. |

## The loop

1. Run `validate_config` on the site config.
2. Run `run_news` as a dry run. Read each rejection reason.
3. Show the user what would publish. Ask before a live run.
4. Run `run_news` with `live: true` and `approved: true` after the user agrees.
5. Tell the user about `pending_approval` items. A person approves them with the CLI.

## Rules

- Never set `approved: true` without the user's consent for that run.
- Never remove attribution or context to make a summary pass.
- Treat a rejection as a result. Report the reason. Do not loosen the config to force a publish.
- Never approve a sensitive item. There is no tool for it, by design.

## Develop

`npm run ci:local` runs typecheck, build and tests. `npm run e2e` rewrites
docs/e2e-transcript.md. Write the failure mode in docs/failure-modes.md before
the code that handles it. Fixtures use example.test hosts only.
