#!/usr/bin/env bash
set -euo pipefail

status="$(warp-cli --accept-tos status)"
if ! grep -Eq 'Status update:[[:space:]]*Connected([[:space:]]|$)' <<< "$status"; then
  echo 'Cloudflare WARP is not connected.' >&2
  exit 1
fi

trace="$(curl --noproxy '*' -4 -fsS --max-time 15 https://www.cloudflare.com/cdn-cgi/trace)"
if ! grep -qx 'warp=on' <<< "$trace"; then
  echo 'Cloudflare trace did not confirm WARP routing.' >&2
  exit 1
fi
