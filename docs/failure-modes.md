# Failure modes

This list came first. Each failure has a fixture and a test that runs the
real stages on it. A failure is a rejection with a reason, never a crash and
never a silent skip. The test file and stage are in brackets.

| # | Failure | Expected result | Stage |
| --- | --- | --- | --- |
| F1 | A feed is down (network error or 5xx). | The run goes on with the other feeds. The report lists a source error for that feed. | discover |
| F2 | A feed has malformed XML. | Source error `malformed_feed`. No items from that feed. | discover |
| F3 | The same story is in two feeds, with tracking parameters in one URL. | One item kept. The other is rejected `duplicate_url`. | dedupe |
| F4 | Two items with a near-identical title on different URLs. | One kept, one rejected `near_duplicate_title`. | dedupe |
| F5 | An item does not match a topic keyword. | Rejected `off_topic`. | filter |
| F6 | An item is older than the recency window, or has no date. | Rejected `stale` or `no_date`. | filter |
| F7 | An item links to a blocked domain. | Rejected `blocked_domain`. | filter |
| F8 | An item links to a host off the fetch allow-list. | Rejected `host_not_allowed`. | filter |
| F9 | The article URL redirects to a host off the allow-list. | Rejected `redirect_off_allow_list`. The library does not request the new host. | fetch |
| F10 | robots.txt disallows the article path. | Rejected `robots_disallowed`. | fetch |
| F11 | The article is a paywall or login page. | Rejected `paywall` or `login_required`. | fetch |
| F12 | The article is too large or too slow. | Rejected `too_large` or `timeout`. | fetch |
| F13 | The summary has a number, date, currency amount or name that is not in the source. | Rejected `unsupported_number`, `unsupported_date`, `unsupported_amount` or `unsupported_name`. | verify |
| F14 | The summary copies a run of 8 or more source words outside one short quote. | Rejected `copied_run`. | verify |
| F15 | The TL;DR has more than 2 sentences. | Rejected `tldr_too_long`. | verify |
| F16 | `requireContext` is true and the article adds no context. | Rejected `no_added_context`. | verify |
| F17 | The config is `sensitive` and nobody approved the item. | Status `pending_approval`. Nothing is published. | approve |
| F18 | The run repeats (cron retry) after a publish. | No second publish. Status `already_published`. | dedupe |
| F19 | A publish target fails. | Status `publish_failed` with the target error. The item is not marked published. | publish |
| F20 | More items pass than `maxItemsPerDay` allows. | Extra items are rejected `daily_cap`. | publish |
