#!/usr/bin/env bash
# Post-deploy smoke test: the live Worker's route guards and the header that
# keeps workspace links out of Referer. It creates no workspace and calls no
# model: every request is refused before a Durable Object is reached, or is
# a static page.
#
# Usage: npm run smoke -- https://codex-guard.<your-subdomain>.workers.dev
set -euo pipefail

url="${1:?Usage: npm run smoke -- <deployed URL>}"
url="${url%/}"
failures=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected '$expected', got '$actual'"
    failures=$((failures + 1))
  fi
}

status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true
}

referrer_policy() {
  curl -s -D - -o /dev/null --max-time 15 "$1" |
    grep -i '^referrer-policy:' | head -n 1 | cut -d: -f2- | tr -d ' \r' || true
}

# D25: only the chat agent is routable
check "the neuron budget isn't routable (404)" 404 \
  "$(status "$url/agents/neuron-budget/x")"

# D15: workspace IDs are accepted only in lowercase
check "an uppercase workspace ID is refused (400)" 400 \
  "$(status "$url/agents/chat-agent/6F1C2D3E-4B5A-4C6D-8E7F-9A0B1C2D3E4F")"

# The link is the credential (DESIGN.md §2)
check "the home page sends Referrer-Policy: no-referrer" no-referrer \
  "$(referrer_policy "$url/")"
check "a workspace page sends Referrer-Policy: no-referrer" no-referrer \
  "$(referrer_policy "$url/w/00000000-0000-4000-8000-000000000000")"

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
