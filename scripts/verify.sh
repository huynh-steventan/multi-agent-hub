#!/usr/bin/env bash
# verify.sh — the canonical gate. Every skill ends on this; a change is not
# done until it passes. Exits nonzero on any failure.
#
# Auto-detects project type and runs what exists; replace the TODO markers with
# your project's real smoke steps as it grows a surface worth exercising.

set -euo pipefail
cd "$(dirname "$0")/.."

ran_something=0
say() { printf '\n== %s ==\n' "$*"; }

# ---------------------------------------------------------------------------
# Node / TypeScript
# ---------------------------------------------------------------------------
if [ -f package.json ]; then
  if grep -q '"typecheck"' package.json; then
    say "npm run typecheck"
    npm run typecheck
    ran_something=1
  fi
  if grep -q '"test"' package.json; then
    say "npm test"
    npm test
    ran_something=1
  fi
fi

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  if command -v pytest >/dev/null 2>&1; then
    say "pytest"
    pytest
    ran_something=1
  else
    echo "note: Python project detected but pytest is not installed — skipping tests." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Project-specific smoke steps — the end-to-end proof, not just typecheck.
# ---------------------------------------------------------------------------
# Build the frontend first so the smoke can assert it is actually served.
say "npm run build:web"
npm run build:web
ran_something=1

# Boots the real server against a throwaway DATA_DIR and exercises every
# endpoint. Costs no agent turns — it never sends a prompt.
say "smoke"
node scripts/smoke.mjs
ran_something=1

if [ "$ran_something" -eq 0 ]; then
  echo "verify.sh: no checks ran — wire up typecheck/tests (and smoke steps) for this project." >&2
  exit 1
fi

say "verify: all checks passed"
