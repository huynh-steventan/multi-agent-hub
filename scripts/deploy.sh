#!/usr/bin/env bash
# deploy.sh — put the working tree live. Run it as `npm run deploy`.
#
# Only relevant if you installed the hub as a service (`bash deploy/install.sh`).
# For plain `npm start` there is nothing to deploy: stop it and start it again.
#
# The hub runs as a launchd user agent (`com.multi-agent-hub.server`) serving a
# pre-built frontend, published to the tailnet by `tailscale serve`. Three things
# therefore have to happen for an edit to be visible on the phone, and doing two
# of them is the failure mode this script exists to prevent: the server keeps
# running the old code, or the browser keeps getting the old bundle.
#
#   1. build the frontend      — the server only ever serves web/dist
#   2. restart the service     — tsx does not hot-reload under launchd
#   3. re-assert tailscale serve — cheap, and the mapping is easy to lose
#
# Then it proves the result rather than assuming it: the health check confirms
# the new process is up, and the bundle check confirms what the server hands out
# is the bundle we just built.
#
# First run on a machine delegates to deploy/install.sh, which owns rendering the
# plist. Afterwards this restarts in place, which is faster and avoids the
# bootout/bootstrap race where the new process can find the port still held.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="com.multi-agent-hub.server"
PLIST_TEMPLATE="deploy/launchd/$LABEL.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/multi-agent-hub/server.log"
HTTPS_PORT="${HTTPS_PORT:-9443}"

TAILSCALE="${TAILSCALE:-$(command -v tailscale || true)}"
[ -n "$TAILSCALE" ] || TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale

# The installed plist is the authority on the port: it sets PORT in the service's
# environment, and real env beats .env in config.ts. Reading it back keeps this
# script from becoming a third place that has to be edited in step.
if [ -f "$PLIST_DST" ]; then
  PORT="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "$PLIST_DST" 2>/dev/null || echo '')"
fi
PORT="${PORT:-4319}"

say() { printf '\n== %s ==\n' "$*"; }

say "build frontend"
npm run build:web

# --- restart ----------------------------------------------------------------

if ! launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  say "service not installed — running the installer"
  exec bash deploy/install.sh
fi

# A plist change only takes effect on a fresh bootstrap. The installed copy is
# rendered from the template, so compare against a fresh render rather than
# against the template itself — otherwise this reinstalls on every single deploy.
if [ ! -f "$PLIST_DST" ] || [ "$PLIST_TEMPLATE" -nt "$PLIST_DST" ]; then
  say "plist template changed — reinstalling the service"
  exec bash deploy/install.sh
fi

say "restarting $LABEL"
# kickstart -k stops the job and starts it again as one operation, so the new
# process never races the old one for the port. In-flight turns are interrupted
# by the server's own SIGTERM handler.
launchctl kickstart -k "gui/$UID/$LABEL"

# --- prove it came back -----------------------------------------------------

say "waiting for 127.0.0.1:$PORT"
healthy=""
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.5
done
if [ -z "$healthy" ]; then
  echo "server did not come back healthy — last 20 lines of $LOG:" >&2
  tail -20 "$LOG" 2>/dev/null || true
  exit 1
fi
echo "healthy"

# Vite fingerprints the bundle, so the filename in the freshly built index.html
# is a precise answer to "is what I just built the thing being served?" — which
# a health check alone cannot tell you.
say "checking the served bundle is the one just built"
built="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' web/dist/index.html | head -1)"
served="$(curl -fsS "http://127.0.0.1:$PORT/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)"
if [ -z "$built" ] || [ "$built" != "$served" ]; then
  echo "the server is not serving the build just produced (built '$built', served '$served')" >&2
  exit 1
fi
echo "serving $built"

# --- publish ----------------------------------------------------------------

if [ ! -x "$TAILSCALE" ]; then
  say "live (local only)"
  echo "local: http://127.0.0.1:$PORT"
  exit 0
fi

say "re-asserting tailscale serve on :$HTTPS_PORT"
# Idempotent: re-stating an identical mapping is a no-op. Always pass --https
# explicitly — omitting it takes the tailnet default :443.
"$TAILSCALE" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"

DNS_NAME="$("$TAILSCALE" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"

say "live"
echo "local:   http://127.0.0.1:$PORT"
[ -n "$DNS_NAME" ] && echo "tailnet: https://$DNS_NAME:$HTTPS_PORT"
echo "logs:    $LOG"
echo
echo "The phone caches the page shell — pull to refresh if it looks unchanged."
