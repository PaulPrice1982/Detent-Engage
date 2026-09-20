#!/bin/bash
#
# Boots the build the demonstration is filmed against.
#
# Every credential comes from the environment. None is written here: this file
# is in the repository, and a password in a repository is a password that has
# leaked, whatever it protects. See README.md in this directory for the
# variables and for how the demonstration accounts are created.
set -u
: "${DETENT_CONSOLE_PASSWORD:?Set DETENT_CONSOLE_PASSWORD. See docs/demo/capture/README.md}"
: "${DETENT_SESSION_SECRET:?Set DETENT_SESSION_SECRET (32 characters or more)}"

REPO="${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}"
LOG="${LOG:-${TMPDIR:-/tmp}/detent-demo-server.log}"
PORT="${PORT:-8901}"

cd "$REPO" || exit 1

# Only this repository's server, and never this script's own shell: a broad
# pattern here kills the terminal it was typed into.
for pid in $(pgrep -f "node .*packages/server/src/main.ts"); do
  [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null
done
sleep 2

DATABASE_URL="${DATABASE_URL:-postgres://appowner@127.0.0.1:5433/detent_demo}" \
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}" \
AWA_DEV_PRINT_KEYS=1 AWA_DEMO_SEED=1 PORT="$PORT" \
AWA_FEATURE_SPOKEN_VOICE=1 \
AWA_TENANT_ID='t_northwind' AWA_TENANT_NAME='Northwind Logistics Group' \
AWA_ORIGINS="http://localhost:$PORT,http://127.0.0.1:$PORT" \
DETENT_CONSOLE_EMAIL="${DETENT_CONSOLE_EMAIL:-ops@detentgtm.io}" \
setsid node tools/run.mjs packages/server/src/main.ts > "$LOG" 2>&1 < /dev/null &
disown

for _ in $(seq 1 40); do
  sleep 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")" = "200" ] && break
done

grep -E "listening|demo action" "$LOG"
# The widget key is printed once at boot and never again. The capture scripts
# read it from here rather than being given it.
grep -o 'awa_pub_[A-Za-z0-9_-]*' "$LOG" | head -1 > "$(dirname "$0")/wk.txt"
echo "widget key written to $(dirname "$0")/wk.txt"
