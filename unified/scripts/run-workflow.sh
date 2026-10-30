#!/usr/bin/env bash
set -euo pipefail
case "${RUN_STAGE:-all}" in all|merge) ;; *) exit 2;; esac
cache=.cache/unified-workflow
publish_dir="$cache/publish"
branch=unified-data
mkdir -p "$cache"
bash shared/warp/check.sh
gh auth setup-git
# Fetch committed snapshots once; a source workflow may keep publishing meanwhile.
for provider in animeworld animesaturn; do
if git ls-remote --exit-code --heads origin "refs/heads/$provider-data" > "$cache/$provider-ref"; then
  git fetch --depth=1 origin "$provider-data"
  git archive FETCH_HEAD "providers/$provider/data" | tar -x
else
  result=$?
  if [[ "$result" == 2 ]]; then echo "$provider has not published its first snapshot yet; retry on the next schedule."; exit 0; fi
  exit "$result"
fi
done
git init -b "$branch" "$publish_dir"
git -C "$publish_dir" remote add origin "https://github.com/${GH_REPO}.git"
git -C "$publish_dir" config user.name 'github-actions[bot]'
git -C "$publish_dir" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if git -C "$publish_dir" ls-remote --exit-code --heads origin "refs/heads/$branch" > "$cache/data-ref"; then
  git -C "$publish_dir" fetch --depth=1 origin "$branch"
  git -C "$publish_dir" checkout -B "$branch" FETCH_HEAD
  mkdir -p unified/data
  rsync -a "$publish_dir/unified/data/" unified/data/
else
  result=$?
  if [[ "$result" != 2 ]]; then exit "$result"; fi
fi
started=$(date +%s)
while true; do
  bash shared/warp/check.sh
  node unified/scripts/pipeline.js | tee "$cache/batch.log"
  node unified/scripts/verify.js
  bash shared/warp/check.sh
  mkdir -p "$publish_dir/unified/data"
  rsync -a --exclude='*.tmp' unified/data/ "$publish_dir/unified/data/"
  git -C "$publish_dir" add -- ':(glob)unified/data/**/*.json'
  if ! git -C "$publish_dir" diff --cached --quiet; then
    git -C "$publish_dir" commit -m 'Update unified anime database checkpoint'
    git -C "$publish_dir" push origin "HEAD:refs/heads/$branch"
  fi
  summary=$(sed -n 's/^UNIFIED_BATCH //p' "$cache/batch.log" | tail -n 1)
  work=$(node -e 'console.log(JSON.parse(process.argv[1]).hasImmediateWork)' "$summary")
  if [[ "$work" != true || "${RUN_STAGE:-all}" == merge ]]; then exit 0; fi
  if (( $(date +%s)-started >= 240*60-300 )); then
    gh workflow run update-unified.yml --ref main -f stage=all
    exit 0
  fi
done
