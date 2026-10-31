# AnimeUnity

Code and tests live in `providers/animeunity/` on `main`. The complete persisted
snapshot lives at `providers/animeunity/data/` on the independent `animeunity-data`
branch. That directory is ignored in the code checkout.

The snapshot includes raw records, mappings, final items/shards/manifests,
enrichment caches and partial progress, discovery state, image health,
`refresh-state.json`, and its own `vega-providers.ref`. Changing paths does not
change record contents, hashes, identifiers or enrichment versions.

## Runner

The workflow checks out its triggering commit (also for a validation branch),
restores one committed data snapshot into an isolated publisher checkout, verifies
it, builds the exact Vega revision recorded in the snapshot, and resumes work.
Checkpoint commits only target `animeunity-data`; code is never pulled or updated
inside a running job. Missing snapshots fail closed instead of starting an empty
database. The existing concurrency group also protects the link-migration job.

`update` resumes a persisted full refresh with its original date and stage.
`single_batch` publishes one batch without dispatching a continuation; non-main
validation requires this setting. `verify_only` runs all tests and snapshot
verification without scraping or publishing. Normal scheduled runs continue the
existing checkpointed loop. The workflow remains disabled during migration.

For local inspection restore the branch snapshot first, including its revision
file, then run `npm run verify:data`. `npm run verify:all` runs all provider and
unifier regression tests. The anime unifier imports AnimeUnity from the data
branch alongside its other source snapshots.

## Recovery reference

- Original working code and data: `6675901eabad0033302a5cc95250a638f58b4740`.
- Remote recovery tag: `safety-animeunity-before-reorganization-20261031`.
- Initial migrated data commit: `c8663cf3b8f4a046b04d5a4fe32bbe66e9fc50b7`.
- Original data tree: `9a97e3da9c19183f69011a9828aa444d93cd8c95`.
- All 78,462 original tracked snapshot files have identical Git blobs at the new
  location. The only added snapshot file is its Vega revision marker.

For rollback first disable/cancel AnimeUnity jobs, retain the newest data branch
commit as another recovery reference, and restore the original code plus its
matching original snapshot via a normal revert/recovery commit on main. Never
force-push or erase checkpoint history. Returning to the original snapshot may
repeat work after that snapshot. Do not resume old root-path scripts against only
the new directory layout, or a new resolver revision against old fingerprints
without an intentional migration.
