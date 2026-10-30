#!/usr/bin/env bash
set -euo pipefail
mode="${RUN_MODE:-update}"
stage="${RUN_STAGE:-all}"
data_dir=providers/filmez/data
cache_dir=.cache/filmez-workflow
data_branch=filmez-data
publish_dir="$cache_dir/publish"
started_at=$(date +%s)
budget_seconds=$((240 * 60))
case "$mode" in full|update) ;; *) exit 2;; esac
case "$stage" in all|discover|details|publish) ;; *) exit 2;; esac
mkdir -p "$cache_dir"
bash shared/warp/check.sh
gh auth setup-git
git init -b "$data_branch" "$publish_dir"
git -C "$publish_dir" remote add origin "https://github.com/${GH_REPO}.git"
git -C "$publish_dir" config user.name 'github-actions[bot]'
git -C "$publish_dir" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if git -C "$publish_dir" ls-remote --exit-code --heads origin "refs/heads/$data_branch" > "$cache_dir/branch-ref"; then
  git -C "$publish_dir" fetch --depth=1 origin "$data_branch"
  git -C "$publish_dir" checkout -B "$data_branch" FETCH_HEAD
  mkdir -p "$data_dir"
  rsync -a --exclude='*.tmp' "$publish_dir/$data_dir/" "$data_dir/"
else
  result=$?
  if [[ "$result" -ne 2 ]]; then echo 'Unable to check the Filmez data branch.' >&2; exit "$result"; fi
  echo 'First build: the independent data branch will be created at the first checkpoint.'
fi

publish_checkpoint() {
  mkdir -p "$publish_dir/$data_dir"
  rsync -a --exclude='*.tmp' "$data_dir/" "$publish_dir/$data_dir/"
  git -C "$publish_dir" add -- ":(glob)$data_dir/**/*.json"
  if git -C "$publish_dir" diff --cached --quiet; then return; fi
  git -C "$publish_dir" commit -m "Update Filmez database ($stage checkpoint)"
  # This branch is exclusive to Filmez. Never pull/commit/push the main
  # code branch or another provider's output while saving a checkpoint.
  for attempt in 1 2 3 4 5; do
    bash shared/warp/check.sh
    if git -C "$publish_dir" push origin "HEAD:refs/heads/$data_branch"; then return; fi
    sleep "$((attempt * 2))"
  done
  echo 'Unable to publish checkpoint; refusing to overwrite the remote data branch.' >&2
  return 1
}

while true; do
  bash shared/warp/check.sh
  if RUN_MODE="$mode" RUN_STAGE="$stage" node providers/filmez/scripts/pipeline.js | tee "$cache_dir/batch.log"; then
    pipeline_failed=0
  else
    pipeline_failed=1
  fi
  summary=$(sed -n 's/^FILMEZ_BATCH //p' "$cache_dir/batch.log" | tail -n 1)
  if [[ -z "$summary" ]]; then echo 'No valid batch summary; aborting.' >&2; exit 1; fi
  bash shared/warp/check.sh
  node providers/filmez/scripts/verify.js
  publish_checkpoint
  work=$(node -e 'console.log(JSON.parse(process.argv[1]).hasImmediateWork)' "$summary")
  complete=$(node -e 'console.log(JSON.parse(process.argv[1]).complete)' "$summary")
  printf 'Filmez checkpoint published: complete=%s, immediateWork=%s\n' "$complete" "$work"
  if [[ "$pipeline_failed" -ne 0 ]]; then
    echo 'Batch interrupted; saved checkpoint will resume on the next scheduled/manual run.' >&2
    exit 1
  fi
  if [[ "$work" != true || "$stage" == publish ]]; then exit 0; fi
  # The durable full-refresh marker is read by update mode on continuation.
  mode=update
  if (( $(date +%s) - started_at >= budget_seconds - 300 )); then
    gh workflow run update-filmez.yml --ref main -f mode=update -f stage="$stage"
    echo 'Queued Filmez continuation after saving the checkpoint.'
    exit 0
  fi
done
