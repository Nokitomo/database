# AnimeWorld database

Standalone scraper of AnimeWorld's public catalogue and metadata. It does not
require a `vega-providers` implementation, account, or external metadata API.
It does not query AniBridge, TMDB, TVDB, AniList, MAL, or any streaming service.
IDs/links to those sites are retained only when AnimeWorld already supplies them.
Vega will need an adapter for this documented schema and URL references; the
database does not itself implement playback or register a provider in the app.

## Files and publication

- `scripts/`: discovery, HTTP session, parsers, pipeline, verification, runner.
- `tests/`: offline network and restart/failure regression tests.
- `data/items/{numeric-id}.json`: one complete provider record per anime.
- `data/catalog.json`: compact search/browse records.
- `data/shards/00.json` through `99.json`: complete records grouped by ID modulo
  100, for an initial offline download and subsequent selective downloads.
- `data/manifest.json`: current domain registry, membership, content hashes,
  progress and errors. Consumers use this manifest rather than listing files.
- `data/state.json`: archive cursor, feed watermarks, retry queues and full-run
  cutoff. This is crawler state, not an application download.
- `data/archive.json`: last fully validated archive snapshot.

Code lives on `main`. Actions publishes generated JSON to the separate
**`animeworld-data` branch** of this repository, using the same directory paths.
The branch is created automatically at the first checkpoint and contains only
AnimeWorld data. Its writes cannot race AnimeUnity's pushes to `main`. The next
run loads that branch's last checkpoint before scraping. This also keeps the
new workflow's source checkout small. The repository's privacy applies to both
branches; distributing data to an app will need a separate publication design.

## Source coverage and URLs

The site address is resolved from `https://pastebin.com/raw/KgQ4jTy6`, with
`https://www.animeworld.ac` as the fallback. Both must pass homepage validation.
If neither works, the run fails without replacing valid records. Session cookies
and CSRF tokens stay in memory and are never included in JSON or logs.

Each record retains titles, original title, full synopsis, type, audio/dub flag,
date/season, studios, genres, duration, declared episode count, actual episode
entries and variants, rating/votes/views, trailer, related/recommended anime,
tooltip aliases, calendar metadata, source metadata labels and available JSON-LD.
Artwork includes posters, sharing covers, homepage banners and related/schedule
posters actually exposed by the site. Sharing covers are not assumed to be
backgrounds. Site logos, user avatars, comments, advertisements and generic player
placeholders are not anime artwork. No images or video files are downloaded.

AnimeWorld's episode lists currently supply IDs, tokens, numbers and links.
Episode titles, synopses and thumbnails remain null if absent in the source;
the generic series synopsis is never substituted for an episode synopsis.
The displayed total is stored separately from available entries, including for
upcoming titles. One Piece's entire episode list is in a single HTML response.

Page paths are relative, e.g. `/play/one-piece-subita.qzG-LE`. Image references
look like `{"base":"img","path":"/locandine/OnePieceElbafPic.png"}`. Resolve
them with `manifest.origins.img`; resolve page paths with `manifest.origins.site`.
The image origin is observed in actual page markup, not guessed from the site
domain. Only the manifest registry needs changing when a known host changes.
External links/trailers have `{"url":"https://..."}` and retain their own hosts.
`scripts/urls.js` exports the reference resolver. All hashes are SHA-256 of
canonical JSON with recursively sorted object keys (array order is preserved),
not hashes of file bytes. Operational timestamps do not change item hashes.

## Reliable incremental updates

Initial discovery reads every A-Z archive page. The reported total, page number,
page size and unique IDs must agree. First and last pages are checked again
before a scan is accepted. A failed page retains the cursor; inconsistent
pagination restarts discovery with backoff while keeping known records.

After initial completion, scheduled runs check `/newest` and `/updated` every
two hours. They paginate until reaching the previous successful watermark,
continuing across batches if necessary. The first run establishes a feed
baseline; the complete archive supplies the older titles. The complete A-Z
archive is reconciled daily. Changed archive metadata also queues a refresh.
Home banners and the calendar are checked every two hours; changed entries
queue their affected anime. Ongoing, upcoming, unknown-status and zero-episode
titles are rechecked at least every 12 hours when runs are successful. Finished
or dropped titles are checked every 30 days. These are eligibility intervals,
not guarantees when Actions is unavailable or there is a processing backlog.

Only a successful full archive scan can propose an exclusion. Both the anime
page and tooltip must then confirm absence (404/410 or their explicit provider
not-found templates, which currently use HTTP 200) before the title is excluded. All
saved metadata remains in `items/` for future reappearance. An unavailable
episode or upcoming anime is not treated as a removed title. A reappearing title
is queued durably and refreshed; existing records remain available meanwhile.

Failures use exponential retry delays from one to twelve hours; network retries
also respect bounded `Retry-After`. A page that succeeds before a tooltip failure
is saved, and only the tooltip is retried. The previous valid record is retained
when the page fails. A full refresh has a persisted starting cutoff, so restart
or continuation does not reprocess successful records from that same refresh.

`manifest.complete` requires validated discovery, source-page and tooltip
coverage for every active record, no outstanding recorded failures, and no due
work at publication. It does not mean absent source metadata has been invented.
Saved but temporarily stale records remain in exports and their retry errors are
visible in the manifest. Each batch is validated before its Git checkpoint is
pushed. Cancellation can lose the uncommitted batch; committed checkpoints persist.

## GitHub Actions

`Update AnimeWorld database` supports `workflow_dispatch` with `mode=update|full`
and `stage=all|discover|details|publish`. A scheduled update runs every two hours
at minute 43; there is no push trigger. With no data, update mode builds the
complete initial catalogue automatically. Use `full` to start a full refresh or
resume the existing one; it never silently resets an unfinished full refresh.
`publish` rebuilds local exports without provider requests. Discovery-only and
details-only runs do not claim that the other work has been completed.

The runner processes batches, publishes checkpoints, and queues a continuation
before its four-hour internal budget expires if work is immediately due. If all
remaining tasks are waiting for retry, it stops and the schedule retries later.
Both this workflow and its continuations have their own concurrency group.

WARP is installed and verified before dependency installation and scraping.
Each HTTP request checks the tunnel state; failed checks block the request.
Checkpoints are published only after a successful WARP routing check. Initial
checkout and WARP bootstrap necessarily occur before the tunnel exists. WARP
and live site behaviour on GitHub's runner can only be confirmed by running the
workflow; offline tests simulate disconnection and rate-limit conditions.

## Validation and explicit local commands

From the repository root:

```sh
npm ci
npm run verify:animeworld
npm run verify:animeworld:live
```

The live smoke check visits three archive pages and three representative anime,
including One Piece and an announced series. It checks temporary exports and
deletes them afterwards; production `data/` is untouched. It does not establish
WARP on a local PC. To test the actual runner route, execute under WARP with
`WARP_REQUIRED=1`.

Explicit local pipeline commands (these DO perform scraping):

```sh
npm run animeworld -- --mode update --stage all --batch-size 50 --archive-pages 20
npm run verify:animeworld:data
```

Use `--data-dir /temporary/path` to keep an experiment separate. The shell runner
is for GitHub Actions and also publishes data; it is not a local test command.
