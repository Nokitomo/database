#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  anime) branch=unified-data; folder=unified/data ;;
  cinema) branch=cinema-data; folder=cinema/data ;;
  *) echo 'Expected anime or cinema coverage.' >&2; exit 2 ;;
esac
mkdir -p .cache/catalog
target=".cache/catalog/$1-coverage.json"
bash shared/warp/check.sh
# A first snapshot may not exist yet. Scraping must remain complete in that case.
if gh api "repos/${GH_REPO}/contents/${folder}/coverage.json?ref=${branch}" \
  -H 'Accept: application/vnd.github.raw+json' > "$target.tmp"; then
  mv "$target.tmp" "$target"
else
  printf 'null\n' > "$target"
  echo 'Coverage unavailable: secondary providers will use complete collection.'
fi
printf 'CATALOG_COVERAGE=%s/%s\n' "$PWD" "$target" >> "$GITHUB_ENV"
