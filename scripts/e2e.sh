#!/usr/bin/env bash
# End-to-end run of the built CLI on the fixture web. No network.
# Usage: npm run e2e   (writes docs/e2e-transcript.md)
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=out/e2e
rm -rf "$OUT" && mkdir -p "$OUT"
CLI="node dist/cli.js"
F=test/fixtures
NOW=2026-11-12T12:00:00Z

step() {
  echo
  echo "## $1"
  echo
  echo '```console'
  echo "\$ agentic-news ${*:2}"
  $CLI "${@:2}" 2>&1
  echo "[exit $?]"
  echo '```'
}

echo "# agentic-news end-to-end transcript"
echo
echo "Fixture web only (example.test). Clock fixed at $NOW. Regenerate with \`npm run e2e\`."
step "Check the config" check-config --config $F/config.json
step "Dry run (default): nothing is published or stored" run --config $F/config.json --fixtures $F/web.json --now $NOW --brief --state $OUT/state.json
step "Live run: write files and queue a social post" run --config $F/config.json --fixtures $F/web.json --now $NOW --brief --state $OUT/state.json --live --out $OUT/articles --queue $OUT/queue.json --channels x,linkedin --link-base https://directory.example.test/news
echo
echo "## Published article"
echo
echo '```markdown'
cat $OUT/articles/*.md
echo '```'
echo
echo "## Queue entry for agentic-publish"
echo
echo '```json'
cat $OUT/queue.json
echo '```'
step "Retried run (cron retry): nothing is published twice" run --config $F/config.json --fixtures $F/web.json --now $NOW --brief --state $OUT/state.json --live --out $OUT/articles --queue $OUT/queue.json --channels x,linkedin
step "Sensitive niche: the item waits for approval" run --config $F/config-sensitive.json --fixtures $F/web.json --now $NOW --brief --state $OUT/sensitive.json --live --out $OUT/sensitive
step "List pending items" pending --state $OUT/sensitive.json
KEY=$(node -e 'const s=require("./'$OUT'/sensitive.json");console.log(Object.values(s)[0].postKey)')
step "Approve the item" approve --state $OUT/sensitive.json --key "$KEY" --by editor
step "Next run publishes the approved item" run --config $F/config-sensitive.json --fixtures $F/web.json --now $NOW --brief --state $OUT/sensitive.json --live --out $OUT/sensitive
step "A bad config is refused with every problem" check-config --config package.json
