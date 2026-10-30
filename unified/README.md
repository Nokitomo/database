# Unified anime catalog

This independent pipeline reads committed AnimeUnity and AnimeWorld snapshots.
It does not scrape source pages, change either source pipeline, or implement
playback in Vega. AnimeWorld source scraping remains a separate workflow.

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

Vega should download only manifest, catalog and active items (or initial shards), never internal
cache/state or either provider source database. Compare the client's saved hashes
with the latest manifest to support missed updates of any duration. Fetch all
files from the **same Git commit**, validate hashes, then atomically activate the
local snapshot. A missing manifest ID removes a record from the active local
catalog. Server-side item files and external caches remain for reactivation.
Hashes use recursively sorted object keys, unchanged array order, compact UTF-8
JSON without trailing newline; they are content hashes, not raw file hashes.

`providers.animeunity` and `providers.animeworld` are arrays: dubbed/subtitled
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
Only AnimeWorld-exclusive groups invoke external enrichment: AniBridge, TMDB,
modular TVDB episode fallback, AniZip and the existing shared artwork resolvers.
No AnimeUnity endpoints or fabricated AnimeUnity pages are used by this adapter.
Range/fractional provider episode labels are retained; ambiguous mappings do not
invent episode metadata. External metadata cannot be guaranteed to exist.

The adapter batches episodes per TMDB season, reuses the existing paced HTTP
client/API authentication/web fallback and durable per-service task cache.
AniBridge is rechecked daily; individual task keys incorporate external target
IDs and seasons. Missing/failed tasks retain the shared retry TTLs. Transport
errors and unmapped titles remain explicitly retryable/unresolved. A successful
attempt does not imply every service supplied every field.

## Execution

`Update unified anime database` runs every two hours and supports manual `all`
or `merge` (no external enrichment). It never runs on push. It waits for the
first AnimeWorld data snapshot, then pins both input snapshots for that run.
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

Activation still requires pushing code, the first source database builds and a
GitHub-run verification of WARP/secrets. Local tests do not certify that remote
environment. Vega integration and initial database completion remain separate.
