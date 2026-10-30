#!/usr/bin/env bash
set -euo pipefail
status="$(warp-cli --accept-tos status)"
if ! grep -Eq 'Status update:[[:space:]]*Connected([[:space:]]|$)' <<< "$status"; then
  echo 'WARP is not connected.' >&2
  exit 1
fi
trace="$(curl --noproxy '*' -4 -fsS --max-time 15 https://www.cloudflare.com/cdn-cgi/trace)"
grep -qx 'warp=on' <<< "$trace" || { echo 'Cloudflare did not confirm WARP routing.' >&2; exit 1; }
