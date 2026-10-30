# AnimeSaturn source database

Independent source scraper, without a dependency on an AnimeSaturn implementation
in Vega providers. External enrichment belongs to the unified catalog workflow.

## Observed site and contract

The shared Pastebin list is `https://pastebin.com/raw/KgQ4jTy6`. At inspection on
2026-10-30 it returned `https://www.animesaturn.net`, also the coded fallback.
Both candidates must return a valid AnimeSaturn homepage. If neither works, the
batch reports a connection error and preserves any previous data. Cookies and
CSRF tokens are retained only in memory, scoped by host/path; no login is needed.

The observed archive is `/az-list`, followed by `/az-list/2` etc: 30 cards per
page, 6,178 titles over 206 pages at inspection. The scraper reads the current
total instead of fixing those numbers in code. Each page's count, active page,
unique IDs and archive total are checked. Before accepting a full scan, the
first and last pages are fetched again and their membership/total compared.

The stable source key is the case-sensitive five-character code at the end of
the anime route, e.g. `8PrAP`. The whole relative route is also retained, so a
slug rename does not change the key. Titles, alternate title, synopsis, type,
status, language, studio, year/date/season, declared and available episode counts,
duration, votes/rating/views, genres, related/recommended cards, external links,
direct AniList/MAL IDs, structured data, SEO data and observed artwork are saved.
Homepage hero artwork is retained as additional banner candidates.

All episode tiles are present in the source HTML, including all 1,180 One Piece
episodes observed during inspection. Declared episode counts never manufacture
episode entries. Each actual episode landing page supplies additional metadata
such as publication date and TVEpisode structured data. Its SEO synopsis and
share cover often describe the series: these stay under `sourceMetadata` and
`images`, not the episode-specific synopsis/thumbnail fields. The scraper does
not open the streaming player, fetch video files, vote or send view-count POSTs.

Provider URLs are relative paths. Images on the observed `img.saturncdn.*` host
use `{base:"images",path:"/..."}`, resolved through `manifest.origins`. The image
origin is learned from source pages, never guessed from the site's hostname.
External hosts stay explicit external URL references. No image files are downloaded.

## Updates and recovery

- Full archive discovery runs daily. Pagination and membership are durable.
- `/api/home/episodes?page=N` and `/newest[/N]` run every two hours and advance
  until reaching the previous head, with bounded resumable page batches.
- Ongoing/upcoming/unknown and empty titles are rechecked every 12 hours.
- Completed/dropped titles and episode metadata are rechecked every 30 days.
- Changes to archive/feed identity, poster or episode markers queue a refresh.
- Full mode refreshes all records and their episode metadata, resuming its marker
  on subsequent batches. Publish mode rebuilds exports without HTTP requests.
- Failures back off for an hour and retain previous valid records and episode
  checkpoints. A completed episode is not downloaded again when resuming a title.

A missing archive entry is not enough to remove a title. Retirement requires
absence from two validated full scans and HTTP 404/410 confirmations separated
by a later full scan. HTTP 200 error/challenge pages never confirm deletion.
Retired items remain on disk; reappearance reuses their data and refreshes it.

## Output and workflow

`providers/animesaturn/data/items/{code}.json` contains each full source record.
Catalog, manifest, 100 shards, archive membership and resumable state are stored
under the same data directory. The manifest lists only active published items.
Partially collected titles are retained and the manifest does not claim complete.

`.github/workflows/update-animesaturn.yml` uses WARP and its own concurrency group.
It runs at minute 53 every two hours, or manually with full/update mode and
all/discover/details/publish stages. It does not run on push. Only the independent
`animesaturn-data` branch receives checkpoints; `main` and other providers are
not pushed by this runner. A batch has a three-minute deadline and up to 50
detail/episode requests. The workflow dispatches continuation near its four-hour
budget, after publishing. A hard runner kill may lose the unpushed current batch,
but previously committed checkpoints remain resumable.

The unified workflow consumes this snapshot alongside AnimeWorld and AnimeUnity.
Shared identities add `providers.animesaturn` and `providerImages.animesaturn`;
exclusive titles use common AniBridge/TMDB/TVDB/AniZip/artwork resolvers and cache.
Conflicts stay separate. Vega ultimately consumes only the unified catalog.

Commands:

```text
npm run animesaturn
npm run verify:animesaturn
npm run verify:animesaturn:data
npm run verify:animesaturn:live
```

The live smoke is explicitly bounded: two archive pages, two anime pages and
at most one episode page per anime; temporary exports are deleted. Tests cover
synthetic complete archives beyond 100 titles, 1,180-episode inventories,
per-episode resume, failures, conservative retirement, host references and actual
Git publication/resume against a temporary local repository. Real GitHub WARP and
the existing TMDB secret can only be validated after code is pushed and run there.
