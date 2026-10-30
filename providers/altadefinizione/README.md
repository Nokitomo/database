# Altadefinizione source database

Source-only Italian film/TV scraper. Code stays on `main`; generated snapshots
live in `providers/altadefinizione/data/` on `altadefinizione-data`.

## Discovery and collection

Resolve the provider through the shared Pastebin, then fall back to
`https://altadefinizionex.forum`. Validate redirects within this provider family
and require a valid archive JSON payload. Public GET requests use host-scoped
cookies, pacing, bounded timeouts/retries and the shared WARP guard. No login,
API secret, playback resolution or video download is required.

The archive is `/api/v1/web/archive`, with `offset`, `limit=30`, `count=1` and
the site's `Data di aggiunta` ordering. Each page validates count, size and IDs.
The scan checkpoints its exact offset, rejects repeated IDs or changing totals,
then rechecks the first-page fingerprint and total. No successful retirement is
inferred from an incomplete scan. Source ordering is not a transactional snapshot;
on detected changes the reconciliation restarts while preserving saved details.

Next.js Flight scripts are decoded as data, never evaluated. Complete title
objects, image alternatives, external IDs, seasons and listed episodes are
collected from detail HTML. Numeric identity must match the requested record.
Season 0, episode 0 and fractional episode numbers are preserved. Declared
counts are retained separately; discrepancies produce warnings, not invented
episodes. A listed episode is not proof of successful playback.

Stable provider IDs identify records. Paths resolve through `origins.site`;
provider image paths through independently discovered `origins.images`.
Unrelated external URLs retain their origin. Artwork alternatives with no
language annotation remain language-unknown. Original provider metadata remains
available; administrative flags and volatile view counters are excluded.

## Updates and recovery

The workflow runs every two hours at minute 37 UTC and supports manual
`update/full` and `all/discover/details/publish`. There is no push trigger.
It scans both addition/update feeds, refreshes observed update-window records,
and performs full weekly reconciliation. Active series refresh daily; movies
and ended series every 30 days. Errors back off one hour. These rotating checks
cover modifications not reflected in the site's update feed.

Complete records replace old records atomically. Every batch publishes durable
checkpoints; after about four hours a continuation is queued when immediate
work remains. Full refresh is durable across continuation jobs. No 100-title cap.
Retirement requires two complete archive omissions plus HTTP 404/410; metadata
is retained with `active:false`, included in hashes and shards, and reused on
reactivation. Transport failures never establish unavailability.

Outputs are `manifest.json`, `catalog.json`, `items/<id>.json`, 100 `shards/`,
and `changes.json`; `state.json` is internal. Consumers use the separate cinema
unifier rather than downloading each source database.

## Verification

- `npm run verify:altadefinizione`: deterministic parsing, recovery, coverage,
  publication and actual runner tests against a temporary local Git remote.
- `npm run verify:altadefinizione:live`: bounded real-site sample, temporary
  export/hash validation and a long series; no production output.
- Add `-- --archive` to inspect the complete live index in memory.
- `npm run verify:altadefinizione:data`: validate published snapshot hashes.

Actual GitHub permissions/WARP reachability require a first remote run after
the user chooses to push. Local tests do not establish remote execution success.

### Verified on 2026-10-30

Full live index scan: **36,503 distinct IDs / 36,503 reported**, with successful
first-page/total boundary validation. The live inspection made 1,228 requests
including detail/export samples; it kept the index in memory and removed the
temporary sample outputs. Additional real details covered long series, older
archive entries, anime and upcoming movies. This is not a full metadata build
of every title. The complete local regression suite passed 175 tests.
