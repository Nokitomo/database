# Unified anime catalog

This independent pipeline reads committed AnimeUnity, AnimeWorld, AnimeSaturn and AnimeTop snapshots.
It does not scrape source pages, change either source pipeline, or implement
playback in Vega. AnimeWorld source scraping remains a separate workflow.

Secondary providers are optional until their first published snapshot. Once a provider
has appeared in sourceSnapshots, its missing snapshot blocks publication. AnimeUnity
is always required. Bootstrap with stage=merge from AnimeUnity alone, then start
AnimeWorld and AnimeSaturn using the published coverage. AnimeTop is optional until
its first published snapshot. Its own animated-series
and animated-film catalogs are collected by an independent workflow. Direct
AniList/MAL IDs can establish identity; records without them stay separate and
explicitly `unmapped`, with their complete source metadata retained. No title-only
or poster-filename match is used. Its original season/episode inventories remain
under `providers.animetop`, and images under `providerImages.animetop`.
AnimeTop episode numbering is marked unresolved until a verified correspondence
exists; external series artwork does not authorize guessing episode mappings.
Unmapped AnimeTop records require no external resolver calls, and refresh locally
on source changes or weekly. Other providers retain their existing behavior.

## Output and consumption

The `unified-data` branch contains `unified/data/`:

- `items/work-N.json`: one canonical work with metadata, artwork, episodes and
  provider variants. AnimeUnity enriched metadata takes precedence.
- `catalog.json`: compact list for browsing.
- `shards/00.json` through `99.json`: grouped complete records for an initial
  download in 100 requests; subsequent updates can download individual items.
- `manifest.json`: canonical SHA-256 item hashes, source snapshot fingerprints,
  image origins, pending counts and identity conflicts.
- `changes.json`: changes since the immediately preceding publication.
- `registry.json`: persistent source-to-canonical identity assignments.
- `enriched/`, `cache/`, `state.json`: internal resumable enrichment data.

Vega should download only manifest, catalog and retained items (or initial shards), never internal
cache/state or either provider source database. Compare the client's saved hashes
with the latest manifest to support missed updates of any duration. Fetch all
files from the **same Git commit**, validate hashes, then atomically activate the
local snapshot. Schema version 2 retains inactive records in itemHashes and shards.
Use `catalog.json` for navigation: it contains active, independently displayed
works. An episode-only work with a complete verified relation to another work
stays `active: true` and retains its provider variants, but has `displayWorkId`
and is omitted from the catalog. The displayed work has `episodeStreamSources`
with provider IDs, source episode numbers and relative paths for live playback.
`episodeOnlyProviders` lists providers contributing only mapped episodes; it is
separate from whole-work `providers` and appears in the catalog row too.
If its primary episode list lacks a mapped special such as episode 0,
`supplementalEpisodes` supplies a display entry without inventing external
metadata. Clients must use these routes when offering streams from the hidden
work; merely filtering catalog rows does not implement playback.
`active: false` means no provider currently confirms availability, and retains
all metadata. `count` includes all retained items. `activeCount` counts available
items, `catalogCount` counts displayed cards, and `inactiveCount` counts unavailable
items. `changes.json` includes `hidden`, `shown`, `deactivated` and `reactivated`;
clients that miss publications must still compare manifest hashes.
Source-confirmed inactive IDs mark provider variants `unavailable`. Missing
membership without confirmation becomes `unknown`, preserves visibility and
prevents claiming complete coverage. `not_matched` means no known association.
An item stays active while any variant is present or its previous availability
is uncertain. Identity reassignment marks the old variant `reassigned` so it
cannot falsely keep a superseded canonical item active. Playback must only use
variants marked `present`, or perform a live check for `unknown` variants.
Retained files from schema version 1 migrate automatically on publication.
Historical provider inventories, images, origins and metadata remain available;
when the metadata provider disappears, its last metadata snapshot is preserved.
Reactivation uses the same canonical identity and existing enrichment caches.
Hashes use recursively sorted object keys, unchanged array order, compact UTF-8
JSON without trailing newline; they are content hashes, not raw file hashes.

`providers.animeunity`, `providers.animeworld` and `providers.animesaturn` are arrays: dubbed/subtitled
variants have independent source IDs, paths and actual episode inventories.
Empty means `not_matched`, not proof of absence from an incomplete archive.
Canonical episode metadata never implies availability on every provider.
`metadataProvider` identifies the source of provider-specific links in `info`.
Artwork references `{base: "animeworld:img", path: "/..."}` resolve through the
manifest origin registry. External image URLs stay external URLs. AnimeUnity's
existing artwork contract is preserved.

Private GitHub data cannot be consumed anonymously. A public distribution/release
or a trusted authentication/distribution service must be chosen before shipping
Vega integration; never embed a personal GitHub token into the app. Release
publishing and the app downloader are deliberately not part of this pipeline.

## Identity and enrichment

Only direct source AniList/MAL IDs establish automatic identity. IDs discovered
in enrichment may also include related works and must not be used for merging.
Conflicting IDs/formats and multiple candidate groups stay separate, with a
report in the manifest. Titles and episode counts never force a match.
`overrides.json` can explicitly assign a `provider:id` to a `work-N` identity
after review. Work IDs persist across provider arrivals and reactivation.

Raw AnimeUnity records count as membership even before final enrichment. Such
records wait for the AnimeUnity pipeline rather than duplicating its work.
Groups absent from AnimeUnity invoke external enrichment using AnimeWorld, or
AnimeSaturn when no AnimeWorld entry exists: AniBridge, TMDB,
modular TVDB episode fallback, AniZip and the existing shared artwork resolvers.
No AnimeUnity endpoints or fabricated AnimeUnity pages are used by this adapter.
Range/fractional provider episode labels are retained; ambiguous mappings do not
invent episode metadata. External metadata cannot be guaranteed to exist.

Both source adapters use the same external resolver and task cache. AnimeSaturn
artwork references use their own `animesaturn:images` origin. Its string source
codes do not collide with the numeric IDs of other providers. No AnimeSaturn
implementation in vega-providers is needed for collecting/enriching metadata.

The adapter batches episodes per TMDB season, reuses the existing paced HTTP
client/API authentication/web fallback and durable per-service task cache.
AniBridge dependencies are compared per exclusive work using the resolver forward/reverse
lookup; unrelated index changes do not enqueue that work. Source metadata/episode changes,
resolver revision changes, due tasks and retries can enqueue enrichment. Ready records
without earlier due tasks have a 30-day refresh ceiling, not a daily refresh. Individual
task keys incorporate external target IDs and seasons. Missing/failed tasks retain the shared retry TTLs. Transport
errors and unmapped titles remain explicitly retryable/unresolved. A successful
attempt does not imply every service supplied every field.

## Execution

`Update unified anime database` supports manual `all` or `merge` (no external
enrichment). Scheduled jobs are gated by the repository variable
`ANIME_SECONDARY_ENABLED=true`: unified runs every two hours, AnimeWorld and
AnimeSaturn every six hours at different minutes. Leave the variable unset until
the initial AnimeUnity-only merge has published coverage. No workflow runs on push.
Input snapshots are pinned for each run; new source checkpoints are merged on a later run.
WARP is checked before requests and publication. `TMDB_API_KEY` uses the existing
GitHub secret. Resolver code is built at the tracked `vega-providers.ref` commit.
The new workflow has its own concurrency group and only pushes `unified-data`.

Batches process up to ten exclusive titles within three minutes, save task
progress and publish a coherent snapshot. The workflow continues batches for
up to four hours, then dispatches a continuation. Transient per-title errors
back off for an hour; future schedules retry them. A killed runner may lose the
current unpushed batch, but earlier commits remain available. Source checksum
failure blocks publication; it never replaces the catalog with an empty result.

Commands: `npm run unified`, `npm run verify:unified`,
`npm run verify:unified:data`. The default pipeline writes `unified/data`; tests
use temporary directories. Do not run the production command locally just to
inspect the catalog. For development, use the exported `run()` with explicit
source/output paths and `stage: 'merge'`.

Activation requires pushing code, an initial unified merge, then source builds and a
GitHub-run verification of WARP/secrets. Local tests do not certify that remote
environment. Vega integration and initial database completion remain separate.

## Lightweight anime availability

A unique, compatible direct AniList/MAL identity matching a ready primary work
allows linked collection even with missing metadata or different episode inventories.
Archive-reported changes still refresh identity, but do not force episode detail scraping
for an identity that remains linked. Uncertain identities and exclusive works retain full
collection. Cinema coverage rules are unchanged. Images and episode links already present
in the fetched anime page may be retained without extra episode requests or external mapping.
The variant carries `episodeResolution: live`; Vega must resolve actual episode availability
and safe numbering at playback. This flag does not implement playback in Vega or claim that
every provider has every canonical episode. Existing metadata is retained.
