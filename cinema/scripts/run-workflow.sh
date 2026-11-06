#!/usr/bin/env bash
set -euo pipefail
case "${RUN_STAGE:-all}" in all|merge) ;; *) exit 2;; esac
export CINEMA_SOURCES="${CINEMA_SOURCES:-streamingunity,altadefinizione,eurostreaming,filmez}"
# Validate before fetching any source snapshot.
node -e 'require("./cinema/scripts/catalog").selectProviders(process.env.CINEMA_SOURCES)'
cache=.cache/cinema-workflow
publish_dir="$cache/publish"
branch=cinema-data
mkdir -p "$cache"
bash shared/warp/check.sh
gh auth setup-git
# Fetch committed snapshots once; a source workflow may keep publishing meanwhile.
IFS=',' read -ra selected <<< "$CINEMA_SOURCES"
for provider in "${selected[@]}"; do
provider="${provider//[[:space:]]/}"
if git ls-remote --exit-code --heads origin "refs/heads/$provider-data" > "$cache/$provider-ref"; then
  git fetch --depth=1 origin "$provider-data"
  git archive FETCH_HEAD "providers/$provider/data" | tar -x
else
  result=$?
  if [[ "$result" == 2 && ( "$provider" == eurostreaming || "$provider" == filmez ) ]]; then echo "Optional provider $provider has no first snapshot; publishing existing providers."; continue; fi
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
  mkdir -p cinema/data
  rsync -a "$publish_dir/cinema/data/" cinema/data/
else
  result=$?
  if [[ "$result" != 2 ]]; then exit "$result"; fi
fi
started=$(date +%s)
while true; do
  bash shared/warp/check.sh
  node cinema/scripts/pipeline.js | tee "$cache/batch.log"
  node cinema/scripts/verify.js
  bash shared/warp/check.sh
  mkdir -p "$publish_dir/cinema/data"
  rsync -a --exclude='*.tmp' cinema/data/ "$publish_dir/cinema/data/"
  git -C "$publish_dir" add -- ':(glob)cinema/data/**/*.json'
  if ! git -C "$publish_dir" diff --cached --quiet; then
    git -C "$publish_dir" commit -m 'Update cinema film and series database checkpoint'
    git -C "$publish_dir" push origin "HEAD:refs/heads/$branch"
  fi
  summary=$(sed -n 's/^CINEMA_BATCH //p' "$cache/batch.log" | tail -n 1)
  work=$(node -e 'console.log(JSON.parse(process.argv[1]).hasImmediateWork)' "$summary")
  if [[ "$work" != true || "${RUN_STAGE:-all}" == merge ]]; then exit 0; fi
  if (( $(date +%s)-started >= 240*60-300 )); then
    gh workflow run update-cinema.yml --ref main -f stage=all -f sources="$CINEMA_SOURCES"
    exit 0
  fi
done
