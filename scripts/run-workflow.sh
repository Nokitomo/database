#!/usr/bin/env bash
set -euo pipefail

stage="${RUN_STAGE:-all}"
mode="${RUN_MODE:-update}"
full_since="${RUN_FULL_SINCE:-}"
state_file=anime_database/refresh-state.json
budget_seconds=$(( 270 * 60 ))
batch_size=200
started_at=$(date +%s)

case "$stage" in all|raw|mapped|final) ;; *) echo "Invalid stage: $stage" >&2; exit 2;; esac
case "$mode" in update|full) ;; *) echo "Invalid mode: $mode" >&2; exit 2;; esac

if [[ "${RUN_EVENT:-}" == schedule && -f "$state_file" ]]; then
  stage=$(node -p "require('./$state_file').stage")
  full_since=$(node -p "require('./$state_file').since")
  mode=full
  echo "Resuming full $stage refresh started at $full_since"
fi
if [[ "$mode" == full ]]; then
  full_since="${full_since:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({stage: process.argv[2], since: process.argv[3]}) + '\n')" \
    "$state_file" "$stage" "$full_since"
fi

mkdir -p .cache
batch=0
while true; do
  batch=$((batch + 1))
  echo "Starting $stage batch $batch ($mode, up to $batch_size records per stage)"
  args=("$stage" --limit "$batch_size" --provider-root .cache/vega-providers)
  if [[ "$mode" == full ]]; then args+=(--full-since "$full_since"); fi
  pipeline_failed=0
  if node scripts/pipeline.js "${args[@]}" | tee .cache/pipeline-batch.log; then
    :
  else
    pipeline_failed=1
  fi
  summary=$(sed -n 's/^PIPELINE_BATCH //p' .cache/pipeline-batch.log | tail -n 1)
  if [[ -z "$summary" ]]; then
    echo 'Pipeline exited before producing a batch summary.' >&2
    exit 1
  fi
  selected=$(node -e "const s=JSON.parse(process.argv[1]); console.log(Object.values(s.selected).reduce((a,b)=>a+b,0))" "$summary")
  if [[ -f .cache/warp-fault ]]; then
    echo 'WARP disconnected during a database request; refusing to publish.' >&2
    exit 1
  fi
  bash scripts/check-warp.sh
  npm run verify:data -- --stage "$stage"
  git add anime_database vega-providers.ref
  if ! git diff --cached --quiet; then
    git config user.name 'github-actions[bot]'
    git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    git commit -m "Update AnimeUnity database ($stage batch $batch)"
    git push
  fi
  echo "Checkpoint published: $selected records processed across stages"
  if [[ "$selected" -eq 0 ]]; then
    complete=$(node -e "const fs=require('fs'); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p)); console.log(Boolean(v.complete))" \
      "$(case "$stage" in raw) echo anime_database/raw/index.json;; mapped) echo anime_database/mapped/index.json;; *) echo anime_database/final/manifest.json;; esac)")
    if [[ "$mode" == full && "$complete" == true ]]; then
      rm -f "$state_file"
      git add anime_database/refresh-state.json
      if ! git diff --cached --quiet; then
        git commit -m "Finish AnimeUnity full $stage refresh"
        git push
      fi
    fi
    if [[ "$pipeline_failed" -ne 0 || "$complete" != true ]]; then
      echo "No records are due now; stage complete=$complete. Remaining errors will be retried on schedule."
    fi
    exit 0
  fi
  if (( $(date +%s) - started_at >= budget_seconds )); then
    echo 'Runner time budget reached after publishing a checkpoint; queuing continuation.'
    if [[ "$mode" == full ]]; then
      gh workflow run update-animeunity.yml --ref main -f mode=full -f stage="$stage" -f full_since="$full_since"
    else
      gh workflow run update-animeunity.yml --ref main -f mode=update -f stage="$stage"
    fi
    exit 0
  fi
done
