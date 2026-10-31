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

## Initial coverage and retries

Final batches reserve 80% of capacity for titles without a final record and 20%
for existing records, filling unused capacity from the other queue. Existing
records rotate oldest-first. Metadata errors persist per-task/per-field/per-episode
retry counters with delays of 30 minutes, 1, 2, 4 hours and progressively longer
intervals up to one week. Success resets the counter. Existing cache entries remain usable; counters
start on their next attempt. Confirmed HTTP 404 responses are treated as missing
metadata (30 days), while blocked/network responses remain retryable. Task
deadlines take precedence over the legacy record-wide TMDB retry timer.
`FINAL_QUEUE` reports new versus refresh selections; `FINAL_RESULT` distinguishes
new records, consumer changes and checks without consumer changes.

## Typed mappings and confirmed missing resources

The database adapter accepts typed AniBridge mappings and explicitly typed AniZip
fallbacks. It does not infer TMDB series from ONA/SPECIAL or copy TVDB seasons and
episode ranges to TMDB. Direct movie mappings take precedence over generic AniZip
IDs. API validation (or canonical web-page validation without a key) checks typed
TMDB resources and scoped seasons. Only a confirmed 404 excludes a target;
transient errors retain source mappings. Rejected targets, reasons and check dates
are preserved in `mappingPolicy` for provenance and later revalidation.

Existing special-season mappings, non-movie records with movie targets and records
with TMDB task errors receive a selective one-time mapping repair. Unaffected
records and provider revision fingerprints stay unchanged. A movie view passed to
Vega does not alter the original raw AnimeUnity type. The in-memory resolver adapter
is scoped to this database context; it does not edit the Vega repository.

Confirmed missing TMDB resources are cached for 30 days in
`data/enrichment-cache/tmdb-resources/`, shared by API/web paths and their children.
A missing gallery never invalidates an entire film, series or season. Network,
authentication and blocking failures remain retryable with increasing delays;
sanitized failure details are recorded in metadata tasks. No negative result
permanently removes an anime. `MAPPING_REJECTED` and `FINAL_RESULT` expose rejected
targets and unresolved metadata independently from fatal pipeline errors.

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

## Source counters and incremental updates

Source fingerprint version 2 excludes only AnimeUnity visite, favorites and
members counters (including episode visits). Raw snapshots still save those
values; changes to episode availability, titles, scores, IDs and other metadata
continue to invalidate enrichment. Counter-only changes do not refresh the
final consumer record or its external metadata.

At pipeline startup, legacy fingerprints and dependent references are migrated
from saved snapshots without provider requests. A stale final record is
reconciled only if its saved source is semantically identical to the current raw
record. Unrelated mapping changes, schema backfills and metadata retry schedules
remain pending. Existing enrichment progress and timestamps are preserved when
its source matches. The migration is repeatable after interruption and logs
SOURCE_FINGERPRINT_MIGRATION. Verification accepts both legacy and v2 snapshots.

Episode collection keeps displayed labels (including combined episodes) separate
from API selectors. If a displayed selector returns the explicit application
error "Episode doesn't exist", retry the same range with ordinal 1 and reuse it
for subsequent ranges. Invalid payloads and HTTP failures remain errors. Conan
Simulcast currently returns 32 video records covering labels 1245-1246 to 1277;
the combined label is preserved and is not split into invented episode IDs.
