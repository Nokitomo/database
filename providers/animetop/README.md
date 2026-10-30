# AnimeTop source database

Collects both AnimeTop catalogs: animated series and animated films, including
western cartoons. Filmez remains a separate, unimplemented provider. Source
code lives in `providers/animetop`; outputs live in `providers/animetop/data`
on the dedicated `animetop-data` branch.

## Discovery and network

1. Resolve Eurostreaming from the shared Pastebin, with its fallback domain.
2. Read its `/elenco-anime-cartoni/` page and extract the AnimeTop link.
3. Validate both AnimeTop archive pages.
4. If discovery fails, validate the saved last-known AnimeTop origin, then
   `https://animetop.net` as the final fallback.

The HTTP client bounds requests, redirects and retries, isolates cookies by
host, paces calls, and checks WARP before every request. Redirects are restricted
to the validated provider families. Website and image references separate origin
from path; same-family site domain changes resolve through `origins.site`.
Unrelated image origins retain separate registry entries. External host links
remain references; videos/streams are not resolved or downloaded.

## Archive and metadata

Public WordPress REST collections `tv_show` and `movie` expose stable numeric
post IDs, totals, modification dates and title paths. Full discovery uses
100-item pages ordered by ID; it checkpoints each cursor and detects duplicate
IDs, changed totals, missing rows and changed boundaries. Both catalogs must
finish before absence reconciliation. Counts are also compared with the HTML
archives. If the API cannot start a scan, a full paginated HTML scan is used.
No fixed page/title cap is applied, and sidebar recommendations are excluded.

Detail HTML supplies title, synopsis, year/release dates, genres, movie runtime,
country, directors/cast/ratings when exposed, publication/modification dates,
posters and all observed image sizes. Related works' images and external IDs are
excluded. JSON-LD is parsed as data; scripts are never evaluated.

Series episode tables preserve original labels, source titles, season numbers,
section headings, host references and alternative rows. Episode zero, fractional
numbers, double episodes and conflicting season headings are retained. The
heading cannot override an explicit episode coordinate. Host icons are not
episode thumbnails. An episode listed by the provider does not prove playback.
Unknown row layouts retain source rows and are retried; previous complete records
are preserved, and a new partial record remains explicitly incomplete.

## Updates and lifecycle

Workflow `update-animetop.yml` runs every two hours at minute 19 UTC, plus manual
`update/full` with `all/discover/details/publish`. It never runs on push.
WARP is required in Actions. A dedicated concurrency group protects its branch.
Three-minute batches publish checkpoints; long builds dispatch continuations
after about four hours. Full refresh markers survive continuation runs.

Modified-date feeds cover recent changes, with overlap against the last feed
checkpoint. If the API is unavailable, HTML heads find recent entries while
rotating detail checks cover other changes. Full reconciliation runs weekly.
Recently changed details refresh daily; unchanged details rotate weekly. Errors
retry after one hour. This also catches edits not reflected in WordPress's
modification timestamps.

Two successful full-scan omissions plus HTTP 404/410 confirm retirement.
Inactive items retain metadata and hashes; rediscovery reactivates them.
Exports include manifest, active catalog, per-title JSON, 100 shards and changes.
The source database is consumed by the unified anime workflow.

## Unified anime integration

AnimeTop is optional until its first data snapshot, so adding its workflow does
not stop existing providers. Once present, source hashes/exports are verified.
`providers.animetop` retains original seasons, episode rows, source metadata and
IDs. Its images use the shared `kind/url` contract under `providerImages.animetop`
with namespaced origins. Existing providers retain metadata priority.

Only direct AniList/MAL IDs establish automatic matching, as for other anime
sources. The inspected AnimeTop samples expose neither, so those titles remain
separate with `enrichment.status: unmapped`, not guessed from title or poster
filenames. They still appear in the final catalog with all provider metadata.
Reviewed identity overrides remain available in the existing unifier. No reverse
TMDB/AniBridge identity guessing is introduced. Unmapped source-only enrichment
is local and rechecked weekly or when source metadata changes.

If a reliable direct anime ID is available, existing external resolvers can
enrich work metadata/artwork. AnimeTop's season/episode correspondence remains
unverified: it is not passed blindly to AniBridge or external episode metadata
resolvers. Original episode titles remain; missing episode data stays missing.
Film/series/anime global unification and Vega app integration remain separate.

## Verification

- `npm run verify:animetop`: parsing, recovery, network/discovery and branch runner tests.
- `npm run verify:animetop:data`: validate exports and hashes.
- `npm run verify:animetop:live`: bounded live samples with temporary exports.
- `npm run verify:animetop:live -- --archive`: complete index scan plus samples.
- `npm run verify:unified`: includes AnimeTop integration and lifecycle regressions.

Live check on 2026-10-31: 1,806 series + 1,632 movies = 3,438 distinct IDs;
70 requests including complete index discovery and 18 detail/export samples.
Boruto's contradictory season headings were preserved and flagged. Temporary
exports are removed. This is not a full metadata build of every source title.
Actual GitHub WARP/permissions require the first remote execution after push.

Final verification: 225 repository tests passed, including real shell runners
against temporary Git remotes, optional-source arrival, retirement/reactivation,
unresolved episode safety and full-refresh continuation. YAML/JavaScript syntax
checks passed. A further four-title live smoke verified actual source records
through the unified loader, image-origin normalization and final export hashes.
