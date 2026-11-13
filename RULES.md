# agentic-news rules

These rules bind every run of agentic-news, including runs that an agent drives over MCP.

1. Preview first. Each run is a dry run unless the caller asks for a live run.
2. Take facts from the source. A summary with a number, date, amount or name that is not in the source is rejected.
3. Do not copy. No run of 8 source words outside one short quote.
4. Credit the source. Every article names its source and links to it.
5. Add context. With requireContext, an article that only restates the source is refused.
6. A person approves sensitive items. Health, legal, money and immigration items wait.
7. Report failures as failures. A failed target never counts as published.
