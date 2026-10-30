# Unified film and series catalog

This separate pipeline combines committed StreamingUnity, Altadefinizione and Eurostreaming
snapshots. Output is `cinema/data/` on branch `cinema-data`. It does not modify
source scrapers, the anime unifier, Vega providers or the app. Global anime/cinema
unification and app downloading/playback integration remain separate work.

Eurostreaming is optional until its first snapshot: existing sources continue
publishing and `awaitingProviders` reports the missing first snapshot. Once
present it is verified like every other source. `complete` refers to the loaded
sources; inspect `awaitingProviders` and `identityIssues` for remaining coverage
and identification limitations. The runner reads each source from its own branch.

Eurostreaming identities use existing shared IDs first, then verified IMDb/TMDB
backlinks through the shared paced API/web transport. Title/year matches are
review candidates only; unresolved records remain separate. Identity results
and retry schedules persist in `identity.json`; merge-only runs reuse them.
Source episode blocks/ITA/SUB ITA versions remain available under the provider.
Standalone Eurostreaming episode numbering is unverified, so external episode
metadata is not assigned automatically. Other providers retain their existing
metadata behavior and priority.

## Identity and metadata

Match direct TMDB, IMDb or TVDB IDs with the media type. Conflicting IDs keep
records separate and appear in `manifest.conflicts`; titles alone never merge.
A persistent source-to-work registry keeps IDs stable as providers arrive.
Merged historic works retain inactive alias records. Missing source membership
stays `unknown` and prevents full-completion claims; source-confirmed inactive
variants become `unavailable`. Metadata and image origins remain retained.

StreamingUnity is the preferred metadata source. Useful Altadefinizione fields
fill individual gaps; both source records' metadata and actual season/episode
inventories remain available under `providers`. Matching episode coordinates
can fill individual fields when inventories and meaningful titles agree.
Different inventories or episode titles produce warnings and no forced field
merge. Provider inventory is distinct from canonical episode metadata.

The pinned existing Vega resolvers provide TMDB image inventories and metadata,
TVDB artwork and modular episode fallback, with their Italian/English preferences,
API/web fallback, pacing and durable per-service request cache. Episode zero,
fractions and ambiguous source numbering are not guessed. Season zero with
ordinary episode numbers is supported. A provider-listed episode is not verified
playback availability. Missing external metadata may genuinely not exist.

External work checkpoints media/artwork/season results inside an item. Progress
is bound to the source fingerprint and expires after a day; failed results do not
become successful checkpoints. Source changes trigger new attempts. Unchanged
complete records refresh externally every 30 days, missing/unmapped metadata
weekly, and errors after an hour. Previously successful per-service tasks are cached.

## Publication

The workflow runs every two hours at minute 49 UTC, manually with `all` or
`merge`, never on push. It waits for both source branches, loads each committed
snapshot once, verifies hashes, then publishes only its dedicated branch.
WARP is required; `TMDB_API_KEY` uses the existing GitHub secret. Long runs queue
continuations. `merge` does not make external enrichment requests.

Downloadable artifacts: manifest, compact active catalog, per-work items and
100 initial-download shards. Inactive items remain hashed. Compare local hashes
against the latest manifest to support missed updates; pin all downloads to one
commit and activate only after validation. `registry`, `state`, `drafts`,
`enriched` and `cache` are internal. Private GitHub delivery authentication must
be designed before app integration; never embed a personal GitHub token.

`complete` requires complete sources, no identity conflicts/unknown availability,
and no pending enrichment. It does not promise every optional external field
exists. Warnings and `hasMissingEpisodeMetadata` expose remaining uncertainty.

Commands: `npm run cinema`, `npm run verify:cinema`, `npm run verify:cinema:data`.
Tests use isolated temporary outputs and temporary local Git remotes.
`npm run verify:cinema:live` collects four real source samples into a temporary
directory, verifies their snapshots and confirms YAGA merges while the two
different Sacrifice titles remain separate; temporary files are removed afterward.

Verified live on 2026-10-30: four source records produced three canonical records.
YAGA (TMDB 314360 / IMDb tt39980704) merged and episode fields complemented each
other. Sacrifice TMDB 1182831 and 1284186 stayed separate. Full regression suite:
175 tests passing, including both real shell runners against temporary Git remotes.
External enrichment is covered by deterministic integration tests using the
existing pinned resolvers' interfaces; the GitHub secret and runner network are
not exercised by the local merge smoke.
