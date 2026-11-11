# StreamingUnity source database

Independent Italian film/TV catalog scraper. No anime merging, external
enrichment, stream resolution, image downloads or Vega app changes occur here.
StreamingCommunity is an alternate origin for the same provider identities.

## Discovery and URLs

Fallback order: StreamingUnity from `https://pastebin.com/raw/KgQ4jTy6`,
`https://streamingunity.fun`, StreamingCommunity from that list,
`https://streamingcommunityz.day`. Each candidate must expose a valid Italian
archive payload. Cookies are host-scoped; requests are paced, bounded, and
WARP-guarded in Actions. Requests use the public Inertia HTML / JSON payloads.
No login or API key is required for this source-only collection.

Record IDs are numeric provider IDs, independent of localized title slugs.
Title and season routes remain relative. Images retain their metadata and a
`{base:"images",path:"/images/filename.webp"}` reference; the manifest resolves
the independently discovered CDN origin. Other external links retain their own
URLs. Temporary preview embeds, tokens and contributor IDs are excluded.

## Complete archive coverage

The archive exposes 60 records per page but rejects page numbers above 20.
The scanner never issues page 21: it splits an oversized query by year, then
media type, then numeric genre. Genre partitions may overlap and are deduplicated
by provider ID. Each accessible partition validates pagination, exact counts,
duplicates and its first page after completion. Empty results are valid only
with a coherent zero-total paginator.

The provider treats years before 2000 as ten-year intervals. Use decade-aligned
partitions there, individual years from 2000 onwards, and explicit `created_at`
ordering throughout archive reconciliation rather than release-date tie ordering.

At the October 2026 inspection the public year filter only accepted 1910 through
the current year. Older/undated titles and unresolved oversized partitions are
covered by residual sitemap candidates: open the title for its name, then require
its ID to appear in an actual **Italian archive search**. An accessible `/it/`
detail page alone is not membership proof; EN-only titles have such pages too.
Search results are also deduplicated; no candidate becomes active just because
it appears in the sitemap. If the sitemap omits a necessary candidate or filters
cannot expose a partition, the scan records an explicit coverage error and
does not declare success or retire missing titles.

A full scan is accepted only when the union of confirmed IT archive IDs equals
the global total and the global newest-page fingerprint and total are unchanged.
Network errors retain the cursor; changed pagination restarts reconciliation
without deleting previously collected items. This protects against common
mid-scan changes; the remote service does not provide transactional snapshots.

## Detail collection and retention

Each `items/<id>.json` contains provider metadata, IDs, artwork, full season
inventory and episode names, plots, thumbnails, duration and audio flags.
Only real returned episodes are saved; no episodes are fabricated from counts.
Requested season identity and episode counts are validated (HTTP 200 can return
the wrong season). Drafts checkpoint after every season; a complete item replaces
its previous version only after all declared seasons have been collected.
Season inventory changes discard the partial draft and schedule a retry.

Source records remain retained with `active:false` after confirmed retirement.
Retirement requires at least one successful full archive omission and HTTP
404/410 from the title page. After one omission, two observations at least six
hours apart are required; two omissions retain the older path to confirmation.
Reviewed removals in `retirements.json` (currently LEGO 66477 and 66478) can skip
the six-hour wait, but never the fresh 404, complete targeted archive search and
two healthy title controls. A changed slug is rediscovered by provider ID and
stale drafts are invalidated. Missing seasons never retire a title.

All paths stop during an unfinished archive scan or when suspects exceed the
larger of five titles and 0.1% of active titles. Network/403/429/5xx responses
reset consecutive 404 evidence; control/search failures leave records active.
Evidence and review reasons persist in state. Rediscovery resets missing evidence,
reactivates the same ID and requires fresh detail collection. Item errors remain
scheduled after their hourly backoff even if archive rediscovery cleared omissions.
Network failures never mean absence. Reactivation reuses the
same source ID. Item hashes and shards include inactive records; catalog contains
only active ones. This is a provider source contract, separate from unified v2.

## Updates and workflow

`Update StreamingUnity database` runs every two hours (minute 23, UTC) or manually.
No push trigger. Modes: `update` or durable `full` refresh. Stages:
`all`, `discover`, `details`, `publish`. The initial update builds from scratch.
The workflow creates `streamingunity-data` at its first checkpoint and writes
only `providers/streamingunity/data/` there. Concurrency is provider-specific.
Each batch has a three-minute deadline; the runner publishes verified checkpoints
and dispatches a continuation after about four hours if immediate work remains.
Failed/transient tasks back off one hour and resume on subsequent schedules.

Every two hours, scan feeds sorted by `created_at` and `last_air_date` until a
previous head is reached. If that crosses the page limit, queue full archive
reconciliation. Full archive reconciliation is weekly; active series are checked
daily, movies and ended/cancelled series every 30 days, and changed archive cards
trigger earlier refresh. `last_air_date` is not a universal metadata modification
timestamp, so rotating detail refreshes remain necessary.

Run `npm run verify:streamingunity` for isolated deterministic tests including
the actual shell publisher against a temporary local Git remote. Run
`npm run verify:streamingunity:live` for a small read-only live smoke, or append
`-- --archive` for a complete live archive coverage inspection kept in memory.
Neither live smoke writes production outputs. Actual scraping is scheduled on
GitHub after code is pushed; remote WARP/permissions still need first-run review.

Outputs: `manifest.json`, `catalog.json`, `items/`, 100 `shards/`, `changes.json`.
`state.json` and `drafts/` are internal checkpoints, not app download artifacts.
Future movie/series enrichment and global unification are intentionally separate.

## Verification on 2026-10-30

Live archive inspection collected exactly **19,162 distinct IT IDs out of
19,162 reported**, including final boundary validation, in 400 total requests
(the count includes small detail/export samples). No page above 20 was requested.
The year/type partitions covered this snapshot without needing residual sitemap
recovery. Separate deterministic tests cover that recovery and its exclusion of
EN-only titles, oversized genre splits and incomplete coverage failures.
Live sample exports validated Sacrifice and Dead-End Job (eight episodes) in a
temporary directory that was removed afterwards. The provider slug containing
`?` for title 6156 was also checked successfully with URL encoding.
These checks validate archive discovery and representative metadata collection;
they are not a full production metadata build for all 19,162 titles.

## Activity counters and refresh decisions

Catalog fingerprints (version 2) exclude views, daily/weekly/monthly/total views,
visite, favorites and members counters, including translation entries whose key
names a counter. Observed counters are retained separately in state.known[id].activityCounters.
Titles, plots, scores, season counts, dates and image metadata still trigger refresh.
Periodic deadlines, retry state and already-pending refreshes are preserved.

Legacy state only contains a hash of the old card, not the card itself. An exact
legacy match upgrades without fetching details. A changed legacy card schedules
one conservative refresh to avoid hiding a real metadata change; subsequent
counter-only observations do not schedule new refreshes. Existing pending work
is never cleared merely by observing an unchanged card.

## Reusing season details

Each detail update still reads the title page. The latest season, new seasons,
changed season descriptors and inventories without an explicit episode count
are fetched. Older seasons can be reused only when ID, number, meaningful
season descriptor and episode count match the saved inventory and their own
last fetch is less than 30 days old. Season zero is included in these checks.

Per-season timestamps survive checkpoint drafts and are not renewed by reuse.
A full refresh bypasses reuse for seasons checked before its cutoff. Legacy
records without these timestamps receive one complete validation. Removed
seasons are excluded from the new record. This optimizes season requests, not
individual episode requests within a fetched season.
