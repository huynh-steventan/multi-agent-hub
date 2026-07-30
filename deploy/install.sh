#!/usr/bin/env bash
# Install multi-agent-hub as a launchd user agent and publish it to your tailnet.
#
# macOS only — launchd is the service manager here. On Linux the equivalent is a
# systemd user unit; nothing else in the project is macOS-specific.
#
# Idempotent: safe to re-run after a code change or a template edit. Re-running
# renders the plist fresh, bootstraps the service, and re-asserts the mapping.
set -euo pipefail

# Everything machine-specific is derived, never hardcoded: the repo from this
# script's own location, HOME and PATH from the invoking shell, the port from
# .env if it sets one.
cd "$(dirname "$0")/.."
REPO="$PWD"

LABEL="com.multi-agent-hub.server"
PLIST_TEMPLATE="$REPO/deploy/launchd/$LABEL.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/multi-agent-hub"
LOG="$LOG_DIR/server.log"

# .env is the single source of truth for the port; fall back to the app default.
PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$REPO/.env" 2>/dev/null | tail -1)"
PORT="${PORT:-4319}"

# The tailnet HTTPS port. Override with HTTPS_PORT=... if 9443 is taken on your
# node — deliberately NOT 443, which is the tailnet default and therefore the
# thing most likely to already be serving something else.
HTTPS_PORT="${HTTPS_PORT:-9443}"

TAILSCALE="${TAILSCALE:-$(command -v tailscale || true)}"
# The Mac App Store build ships the CLI inside the bundle and does not put it on PATH.
[ -n "$TAILSCALE" ] || TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
NPM="$(command -v npm || true)"

say() { printf '\n== %s ==\n' "$*"; }

say "preflight"
[ -f "$REPO/.env" ] || { echo "missing $REPO/.env — copy .env.example and fill it in" >&2; exit 1; }
[ -d "$REPO/web/dist" ] || { echo "web not built — run 'npm run build:web' first" >&2; exit 1; }
[ -n "$NPM" ] || { echo "npm not found on PATH" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$(dirname "$PLIST_DST")"

say "rendering $LABEL"
# The PATH launchd gets is the PATH you are running this with. That is the point:
# launchd sources no shell profile, so an agent CLI that is not reachable from
# here will not be reachable at turn time either.
sed \
  -e "s|__NPM__|$NPM|g" \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PORT__|$PORT|g" \
  -e "s|__PATH__|$PATH|g" \
  -e "s|__LOG__|$LOG|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DST"

say "installing $LABEL"
# bootout is expected to fail the first time; the service is not loaded yet.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

# bootout returns before launchd has finished tearing the job down, and
# bootstrapping into that window fails with "Bootstrap failed: 5: Input/output
# error". That failure is worse than it sounds: bootout already succeeded, so the
# hub is left *down* rather than merely un-updated. Wait for the job to actually
# disappear, then retry instead of trusting a single attempt.
for _ in $(seq 1 40); do
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done

bootstrapped=""
for _ in $(seq 1 20); do
  if launchctl bootstrap "gui/$UID" "$PLIST_DST" 2>/dev/null; then
    bootstrapped=1
    break
  fi
  sleep 0.5
done
[ -n "$bootstrapped" ] || {
  echo "could not bootstrap $LABEL — the hub is not running" >&2
  launchctl bootstrap "gui/$UID" "$PLIST_DST" || true   # once more, for the error text
  exit 1
}

launchctl enable "gui/$UID/$LABEL"

say "waiting for the server to answer on 127.0.0.1:$PORT"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "healthy"
    break
  fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || {
  echo "server did not become healthy — check $LOG" >&2
  tail -20 "$LOG" 2>/dev/null || true
  exit 1
}

# --- publish ----------------------------------------------------------------
#
# Optional. Without Tailscale the hub still works at http://127.0.0.1:$PORT —
# you just cannot reach it from another device.

if [ ! -x "$TAILSCALE" ]; then
  say "done (local only)"
  echo "local: http://127.0.0.1:$PORT"
  echo "logs:  $LOG"
  echo
  echo "Tailscale was not found, so nothing was published. Install it and re-run"
  echo "this script to reach the hub from your phone."
  exit 0
fi

say "publishing to the tailnet on :$HTTPS_PORT"
# Publish on exactly one port, and always state --https explicitly: omitting it
# takes the tailnet default :443, which is easy to collide with. The mapping
# persists across reboots, and re-stating an identical one is a no-op.
"$TAILSCALE" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"

DNS_NAME="$("$TAILSCALE" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"

say "done"
echo "local:   http://127.0.0.1:$PORT"
[ -n "$DNS_NAME" ] && echo "tailnet: https://$DNS_NAME:$HTTPS_PORT"
echo "logs:    $LOG"
echo
echo "stop:    launchctl bootout gui/$UID/$LABEL"
echo "unserve: $TAILSCALE serve --https=$HTTPS_PORT off"
