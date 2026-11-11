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

Match direct TMDB, IMDb or TVDB IDs with the media type across providers.
Different source IDs within the same provider remain separate by default, even
when all external IDs agree. Conflicting IDs keep records separate and appear
in `manifest.conflicts`; titles alone never merge.
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

The workflow is manual (schedules are currently paused), with `all` or `merge`,
never on push. The `sources` input defaults to `streamingunity`; only selected
branches are fetched and verified. Continuations preserve this selection.
It loads each committed snapshot once and publishes only its dedicated branch.
A different source selection requires an explicitly separate output/migration,
to prevent previously retained records leaking into a restricted catalog.
WARP is required; `TMDB_API_KEY` uses the existing GitHub secret. Long runs queue
continuations. `merge` does not make external enrichment requests.

Downloadable artifacts: manifest, compact active catalog, per-work items and
100 initial-download shards. Inactive items remain hashed. Compare local hashes
against the latest manifest to support missed updates; pin all downloads to one
commit and activate only after validation. `registry`, `state`, `drafts`,
`enriched` and `cache` are internal. Private GitHub delivery authentication must
be designed before app integration; never embed a personal GitHub token.

`complete` requires complete sources, no unknown availability and no pending
enrichment. Identity review alerts are independent and do not block completion. It does not promise every optional external field
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

## Filmez

Filmez is an optional independent input from `filmez-data`. Before its first snapshot, `awaitingProviders` reports it without preventing other providers from publishing. Direct compatible external IDs permit merging; missing IDs yield a separate work and review candidates, never a title-only automatic match. Playback links and all source image variants are retained.

## Conservative external episode enrichment

Provider season order, episode numbers, metadata and playback references are retained.
Complete provider episodes cause no external episode requests. Missing fields may be
filled only when the distinctive title is unique within both season inventories and
the episode number agrees. Translated, generic, duplicated or shifted titles remain
unverified; numbering alone never authorizes a match. TVDB must pass its own identity
check and only fills remaining gaps. Series artwork and TMDB season artwork are stored
under their external identity; they are not blindly assigned to provider seasons.

`episode-overrides.json` supports manually verified exceptions keyed by `provider:id`,
then `tmdb`/`tvdb`: `{id, episodes: {"sourceSeason:sourceEpisode":
{season, episode, sourceTitle, evidence}}}`. Overrides are bound to the external ID
and current source title, can cross seasons, and invalidate cached enrichment when
edited. No anime-provider overrides are silently applied to StreamingUnity episodes.
Unknown mappings leave gaps and are reported in `externalMappings`; they are not
transport errors and do not cause immediate infinite retry loops.
Missing IMDb/TVDB IDs may be supplemented through the pinned Wikidata resolver when
its IDs do not conflict with the source. Source metadata always takes precedence.

## Identity review and repair

`identity-review.json` groups shared external identifiers into review cases. Each
case includes stable source keys, work IDs, titles, typed external IDs and relative
provider page references resolved with `manifest.origins`. `possible-duplicate`
means compatible IDs; `conflicting-external-ids` means at least one disagreement.
`pendingReviewCount` and `reviewHash` expose the report in the manifest.

`identity-overrides.json` is durable code configuration. `idCorrections` maps a
source key to `{ids: {tmdb, imdb, tvdb}, reason}` (null clears an incorrect ID).
Corrections apply before identification/grouping and preserve original IDs as
provenance. `decisions` contains `{sources: ["provider:id", ...], decision:
"separate" | "merge", reason}`. A merge requires compatible corrected IDs and type;
a separate decision prevents automatic matching across providers as well.

When loading a legacy registry, the first split record retains the previous work
ID and the others receive new IDs. `identity-migration.json` preserves the resulting
source-to-work assignments. Reassigned variants are removed from the former work,
not retained as ghost memberships. Membership-sensitive fingerprints invalidate
merged metadata/drafts only for affected groups; unrelated enrichment is reused.
The migration is idempotent and runs in both `merge` and `all` modes.

## Confirmed variants and season composition

`identity-overrides.json` merge decisions may include a `catalog` policy:

- `kind: variants` keeps one catalog work and all original provider records. `primary` selects the metadata source; each provider variant retains its original ID, path, seasons and availability. Dated `streamObservation` values are user observations, not guarantees about future streams. `timelineCompatibility: unverified` means subtitles and playback timestamps must not be transferred between copies automatically.
- `kind: seasons` maps source season numbers to TMDB container seasons before assembling episodes. Unmapped future seasons stay in the source inventory and raise a warning. The container receives TMDB work metadata/artwork; only mapped seasons enter the playable catalog. `name` retains the TMDB season name and `displayName` adds the year when names repeat.
- Composed episodes expose `playbackSources` with the original provider title ID, relative path, season number/ID and episode number/ID. Clients must resolve these original coordinates, never send the displayed TMDB season number to the provider.
- `providers[].info` retains declared catalog metadata separately from stream observations. Resolve actual audio/subtitle tracks at playback where possible.
- Previously published work IDs are retained as inactive `replacedBy` records after merging. Consumers should follow the replacement for bookmarks rather than showing a duplicate card.

These policies are applied by the normal cinema workflow, on top of unmodified source databases. `verify:cinema` and the publication verifier cover season composition, preserved playback references, stable aliases and incremental cache reuse. The database contract does not itself implement playback aggregation in Vega.

## Verified metadata replacements

Episode overrides can include a `replacement` with `title`, `synopsis`, and an optional `thumbnail`. These replace known incorrect display metadata before fingerprinting and enrichment, preserving the raw source record. Guards check the original provider title, not the corrected display title. A missing thumbnail field retains the provider image; null explicitly clears it.

Composite targets use `{season, episodes: [...], providerOnly: true}`: one playable provider episode stays one item, with all confirmed TMDB segments recorded. Text can describe both segments; ordinary gap filling must never substitute just one segment or infer a TVDB mapping.

Identity metadata may set `displayTitle` for a verified edition. Variant compositions may set `excludedMetadataSources` for a mislabeled movie copy: its original data and playback ID remain available, but cannot fill canonical text or artwork. These exceptions and their evidence participate in incremental fingerprints.

## SQLite distribution

The independent [SQLite exporter and publisher](sqlite/README.md) consumes pinned,
verified complete Cinema snapshots. It creates `cinema-sqlite` as a publication
pointer and stores full snapshots/deltas in GitHub Releases. It preserves raw
artwork separately from eligible app choices and does not alter the source JSON
format or the Vega app.
