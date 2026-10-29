# AnimeUnity database for Vega

This repository builds an AnimeUnity metadata database for `vega-providers` and
`vega-app`. GitHub Actions runs incremental updates every two hours and also
supports manual full or incremental runs. The workflow commits generated data
back to this repository. No local
computer needs to stay online.

On GitHub's Ubuntu runner, the workflow installs Cloudflare WARP, connects in
`warp+doh` mode, and requires both a connected client status and Cloudflare's
`warp=on` trace before installing project dependencies, cloning Vega, scraping,
or publishing. Pipeline HTTP requests also refuse to start after WARP reports
a disconnection. The initial checkout and WARP installation necessarily happen
before the tunnel exists. A real tunnel check requires the first GitHub Actions
run; local unit tests do not establish a WARP connection on this computer.

## Layout

- `scripts/`: pipeline code.
- `anime_database/raw/`: AnimeUnity archive, info API and episode payloads.
- `anime_database/mapped/`: AniBridge v3 and AniZip mapping results using the
  current Vega provider implementation.
- `anime_database/final/`: Vega `Info` and `EpisodeLink` records plus a compact
  catalog and 100 download shards (`shards/00.json` through `99.json`).
  `manifest.json` is marked `complete` only when every discovered item
  has a current record in every stage.

Every record is keyed by the stable AnimeUnity anime ID. Final records contain
the relative provider path, so a consumer can resolve it against the current
AnimeUnity domain. Episode `link` values are provider episode IDs; stream URLs
are intentionally resolved live by Vega when playback starts.

## Run locally

Node.js 20 or newer and a built checkout of `vega-providers` are required.
The checkout must match `vega-providers.ref` for reproducible output. GitHub
Actions updates this reference automatically from the provider repository's
default branch. When it changes, mapped and final records are refreshed before
the manifest can become complete again.

```sh
npm ci
node scripts/pipeline.js all --ids 4354 --provider-root /path/to/vega-providers
npm run verify
```

Use `--full` to force rechecking records. The normal run checks new titles and
reviews ongoing/upcoming titles daily and other titles every 30 days. It reads
the sitemap each run and reconciles the paginated archive at least daily. Each stage
keeps its successful previous record when an update fails. Generated outputs are
written atomically. The optional `TMDB_API_KEY` repository secret enables TMDB
API lookups; Vega also supports its public web fallback.
Final metadata is revisited every 30 days when artwork or episode details are
missing and every 90 days otherwise, even when AnimeUnity's own record is
unchanged. A missing episode synopsis or logo remains empty when none of the
available sources supplies it.

## GitHub Actions controls

Open **Actions → Update AnimeUnity database → Run workflow** on the `main`
branch. `mode=update` checks new and due records; `mode=full` rechecks every
record, including records built before a new API key was added. `stage=all`
runs raw scraping, mapping and final enrichment. The `raw`, `mapped` and
`final` choices run one phase only. Leave `full_since` blank; it is used to
continue a long full refresh automatically. A code push does not start a full
scrape. Scheduled runs use update mode unless a full refresh is already in
progress.

There is no 100-record total limit. The runner processes 200 records per stage
and commits a verified checkpoint after each batch. GitHub-hosted runners have
a finite job lifetime, so the workflow queues another run when its time budget
is reached. Scheduled runs also resume an unfinished full refresh. Records
that failed are retried after a 30-minute cooldown, allowing other records to
progress meanwhile.

The `TMDB_API_KEY` repository secret is optional and accepts either a TMDB v3 API
key or an API Read Access Token. The Vega AnimeUnity provider uses public TMDB
web pages when it is absent and fills missing API fields from those pages when
it is present. TVDB also uses public pages; AniBridge, AniZip,
Cinemeta and AniList do not require additional secrets in this pipeline. TMDB
API requests are paced to at most four starts per second and a `429` response
waits for `Retry-After` before retrying. The key is never written to the database
or logs.

## Consumer contract

`final/catalog.json` contains compact cards. `final/items/{animeId}.json`
contains `info` (`Info`), `episodes` (`EpisodeLink[]`), source data, mapping
provenance and ordered artwork candidates. Read `final/manifest.json` first and
only promote a generation with `complete: true`. The client should retain its
last known good generation when a download or live refresh fails.
The manifest's `itemHashes` let a client download only changed records.
The `shardHashes` provide a smaller number of downloads for a first offline
installation, followed by changed-shard updates.

The provider integration is a separate change in `vega-providers`: `getPosts`,
`getMeta` and `getEpisodes` should read these records first. Ongoing and upcoming
titles still need the provider's live inventory checks when opened, and new
episodes still need its normal metadata enrichment. Playback stays live.
