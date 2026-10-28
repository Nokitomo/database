#!/usr/bin/env bash
set -euo pipefail

# The GitHub runner must download WARP before its own traffic can use WARP.
sudo apt-get update
sudo apt-get install -y curl gnupg
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg |
  sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
printf 'deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ %s main\n' \
  "$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")" |
  sudo tee /etc/apt/sources.list.d/cloudflare-client.list >/dev/null
sudo apt-get update
sudo apt-get install -y cloudflare-warp
sudo systemctl start warp-svc

sudo warp-cli --accept-tos registration new
sudo warp-cli --accept-tos mode warp+doh

for protocol in MASQUE WireGuard; do
  sudo warp-cli --accept-tos tunnel protocol set "$protocol"
  if ! sudo warp-cli --accept-tos connect; then
    echo "WARP connection over $protocol did not start; trying another protocol." >&2
    continue
  fi
  for attempt in $(seq 1 10); do
    if bash scripts/check-warp.sh; then
      echo "Cloudflare WARP is connected over $protocol; Cloudflare trace reports warp=on."
      exit 0
    fi
    sleep 3
  done
done
echo 'Cloudflare WARP did not establish a verified tunnel.' >&2
exit 1
