#!/usr/bin/env bash
set -euo pipefail
data_dir=providers/animeunity/data
publish_dir=.cache/animeunity-publish
data_branch=animeunity-data
case "${1:-}" in
  restore)
    bash providers/animeunity/scripts/check-warp.sh
    gh auth setup-git
    mkdir -p "$publish_dir"
    git init -b "$data_branch" "$publish_dir"
    git -C "$publish_dir" remote add origin "https://github.com/${GH_REPO}.git" 2>/dev/null || true
    # A missing migrated snapshot is an error, never permission to start over.
    git -C "$publish_dir" fetch --depth=1 origin "$data_branch"
    git -C "$publish_dir" checkout -B "$data_branch" FETCH_HEAD
    for required in raw/index.json mapped/index.json final/manifest.json vega-providers.ref; do
      test -s "$publish_dir/$data_dir/$required" || { echo "Missing checkpoint: $required" >&2; exit 1; }
    done
    mkdir -p "$data_dir"
    rsync -a --delete --exclude='*.tmp' "$publish_dir/$data_dir/" "$data_dir/"
    echo "Restored AnimeUnity snapshot $(git -C "$publish_dir" rev-parse HEAD)"
    ;;
  publish)
    test -d "$publish_dir/.git"
    bash providers/animeunity/scripts/check-warp.sh
    rsync -a --delete --exclude='*.tmp' "$data_dir/" "$publish_dir/$data_dir/"
    git -C "$publish_dir" config user.name 'github-actions[bot]'
    git -C "$publish_dir" config user.email '41898282+github-actions[bot]'
    git -C "$publish_dir" add -A -- "$data_dir"
    if ! git -C "$publish_dir" diff --cached --quiet; then
      git -C "$publish_dir" commit -m "Update AnimeUnity database checkpoint"
      for attempt in 1 2 3; do
        if git -C "$publish_dir" push origin "HEAD:refs/heads/$data_branch"; then exit 0; fi
        sleep "$attempt"
      done
      echo 'Checkpoint push failed; refusing to overwrite remote history.' >&2
      exit 1
    fi
    ;;
  *) echo 'Usage: checkpoint.sh restore|publish' >&2; exit 2 ;;
esac
