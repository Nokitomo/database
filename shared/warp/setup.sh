#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Bootstrapping the tunnel and the initial checkout necessarily precede WARP.
sudo apt-get update
sudo apt-get install -y curl gnupg rsync
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
  sudo warp-cli --accept-tos connect || continue
  for attempt in $(seq 1 10); do
    if bash "$script_dir/check.sh"; then exit 0; fi
    sleep 3
  done
done
echo 'Unable to establish a verified WARP tunnel.' >&2
exit 1
