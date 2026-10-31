#!/usr/bin/env bash
set -euo pipefail

stage="${RUN_STAGE:-all}"
mode="${RUN_MODE:-update}"
full_since="${RUN_FULL_SINCE:-}"
state_file=providers/animeunity/data/refresh-state.json
budget_seconds=$(( 270 * 60 ))
batch_size=50
started_at=$(date +%s)
if [[ "${GITHUB_REF_NAME:-main}" != main && "${RUN_SINGLE_BATCH:-false}" != true ]]; then
  echo 'Non-main validation must use a single batch.' >&2; exit 2
fi
if [[ ! -f "$state_file" && ! -s providers/animeunity/data/raw/index.json ]]; then
  echo 'Restore the migrated snapshot before running.' >&2; exit 1
fi

case "$stage" in all|raw|mapped|final) ;; *) echo "Invalid stage: $stage" >&2; exit 2;; esac
case "$mode" in update|full) ;; *) echo "Invalid mode: $mode" >&2; exit 2;; esac

if [[ -f "$state_file" && ( "${RUN_EVENT:-}" == schedule || "$mode" == update ) ]]; then
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
  if (( batch > 0 && $(date +%s) - started_at >= budget_seconds - 30 * 60 )); then
    echo 'Runner time budget approaching; queuing continuation before another batch.'
    if [[ "$mode" == full ]]; then
      gh workflow run update-animeunity.yml --ref "${GITHUB_REF_NAME:-main}" -f mode=full -f stage="$stage" -f full_since="$full_since"
    else
      gh workflow run update-animeunity.yml --ref "${GITHUB_REF_NAME:-main}" -f mode=update -f stage="$stage"
    fi
    exit 0
  fi
  batch=$((batch + 1))
  echo "Starting $stage batch $batch ($mode, up to $batch_size records per stage)"
  args=("$stage" --limit "$batch_size" --provider-root .cache/vega-providers)
  if [[ "$mode" == full ]]; then args+=(--full-since "$full_since"); fi
  pipeline_failed=0
  if node providers/animeunity/scripts/pipeline.js "${args[@]}" | tee .cache/pipeline-batch.log; then
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
  bash providers/animeunity/scripts/check-warp.sh
  npm run verify:data -- --stage "$stage"
  bash providers/animeunity/scripts/checkpoint.sh publish
  echo "Checkpoint published: $selected records processed across stages"
  if [[ "${RUN_SINGLE_BATCH:-false}" == true ]]; then exit "$pipeline_failed"; fi
  if [[ "$selected" -eq 0 ]]; then
    complete=$(node -e "const fs=require('fs'); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p)); console.log(Boolean(v.complete))" \
      "$(case "$stage" in raw) echo providers/animeunity/data/raw/index.json;; mapped) echo providers/animeunity/data/mapped/index.json;; *) echo providers/animeunity/data/final/manifest.json;; esac)")
    if [[ "$mode" == full && "$complete" == true ]]; then
      rm -f "$state_file"
      bash providers/animeunity/scripts/checkpoint.sh publish
    fi
    if [[ "$pipeline_failed" -ne 0 || "$complete" != true ]]; then
      echo "No records are due now; stage complete=$complete. Remaining errors will be retried on schedule."
    fi
    exit 0
  fi
  if (( $(date +%s) - started_at >= budget_seconds )); then
    echo 'Runner time budget reached after publishing a checkpoint; queuing continuation.'
    if [[ "$mode" == full ]]; then
      gh workflow run update-animeunity.yml --ref "${GITHUB_REF_NAME:-main}" -f mode=full -f stage="$stage" -f full_since="$full_since"
    else
      gh workflow run update-animeunity.yml --ref "${GITHUB_REF_NAME:-main}" -f mode=update -f stage="$stage"
    fi
    exit 0
  fi
done
