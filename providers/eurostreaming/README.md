# Eurostreaming source database

Italian and SUB ITA series, anime and cartoons hosted directly by Eurostreaming.
Filmez and AnimeTop are separate providers and are not crawled. The separate
`eurostreaming.design` site is not assumed to be a mirror.

## Discovery and parsing

Resolve `eurostreamings.*` through the shared Pastebin, then the fallback
`https://eurostreamings.reisen`. Require a valid archive, not just HTTP 200.
Requests use bounded retries, pacing, host-scoped cookies and WARP guards.
Workflow runs require WARP; local live checks do not install or enable it.

Walk every archive page without a fixed page limit. Check page numbers,
nonfinal page size, duplicate IDs, the reported last page and a repeated first
page boundary. Supplement with both series A–Z lists and the local anime A–Z
list; these lists alone cannot confirm absence. An incomplete scan cannot
retire records. The site offers no transactional snapshot or authoritative
unique-title total, so these checks cannot guarantee that the site itself has
listed every title.

WordPress post IDs are the stable identity. Preserve title, descriptive text,
hidden synopsis, meta description, year when explicit, categories/tags, related
links, images and available external IDs. Follow the site's connected episode
page as data, without evaluating JavaScript. Keep original season headings,
episode labels, ITA/SUB ITA variants, links and alternative numbering blocks.
Episode zero, fractions and double episodes are not rounded or renumbered.
Coming-soon blocks are announcements, not available episodes. Host links are
retained as source references; playback is not resolved or verified.

Site references use `{base:"site",path:...}`. Independently observed image
origins use named entries in `manifest.origins`; old and new CDN origins can
coexist. The scraper does not assume that unrelated CDNs are interchangeable.
External links retain their actual origin. A domain change with the same paths
does not require rewriting each site reference. Changed paths are rediscovered.

## Updates and persistence

Dedicated branch `eurostreaming-data`, output `providers/eurostreaming/data/`.
Workflow `update-eurostreaming.yml`: every two hours at minute 43 UTC and manual
`update/full`, stages `all/discover/details/publish`; no push trigger.

The update feed queues recently listed changes. Weekly complete archive and
auxiliary-index scans recover changes beyond its finite window. Recently changed
records are revisited daily; unchanged records rotate weekly. Errors retry after
one hour. Full refresh and discovery cursor survive checkpoint continuations.
Per-batch limits bound work, never cap the total catalog. After roughly four
hours the runner saves a checkpoint and queues a continuation if work remains.

Retirement requires two successful full-scan omissions and HTTP 404/410 for the
main title page. Failure of a connected episode page cannot retire the title.
Metadata is retained with `active:false`; a later observation reactivates it.
Parsing failures preserve the previous valid item and keep completion false.

Exports: manifest, active catalog, one JSON per title, 100 shards and changes.
State/discovery queues are internal. Consumers use the cinema output.

## Cinema integration

The cinema unifier reads this independent source and keeps StreamingUnity,
then Altadefinizione, as metadata priorities. Existing catalogs can publish
before the first Eurostreaming snapshot (`awaitingProviders` reports this).

Shared nonconflicting IDs identify works. Existing source snapshots can supply
missing IDs. Otherwise the cinema stage uses the existing paced TMDB transport
to verify IMDb-to-TMDB identity (API, then web fallback). Title/year searches
produce review candidates only. Uncertain works remain separate; results and
errors have durable caches and retry schedules. `manifest.identityIssues`
reports unresolved cases. `merge` applies cached identities without requests.

Eurostreaming's own episode numbering is explicitly unverified. For standalone
Eurostreaming works the current implementation enriches series artwork/metadata
after identity resolution, but does not attach external episode metadata to
unverified coordinates. When a work joins another provider, its original episode
inventory and variants remain under `providers.eurostreaming`; episode field
merges require matching inventory and meaningful matching titles. Ambiguities
are retained, never guessed. Global anime/cinema unification is separate work.

## Verification

- `npm run verify:eurostreaming`: parser, lifecycle, HTTP and actual branch runner tests.
- `npm run verify:eurostreaming:data`: export/hash validation.
- `npm run verify:eurostreaming:live`: real-site samples in a temporary directory.
- Add `-- --archive` for a complete live index scan held in memory.
- `npm run verify:cinema`: identity, integration and branch-runner regressions.

Live scan across 2026-10-30/31: 305 pages, 5,475 unique archive post IDs,
5,491 distinct paths after auxiliary indexes, 331 requests including 17 detail
samples and export verification. Extra paths may be aliases, not unique works.
This verifies full discovery and representative details, not a full metadata
build of every title. Temporary live exports are removed automatically.

Final regression run: 201 tests passed, with YAML and JavaScript syntax checks.
Live cinema smoke: Yaga joined StreamingUnity, Altadefinizione and Eurostreaming
in one record; the two unrelated Sacrifice works remained separate. Actual
GitHub WARP routing and secret-based API access require the first remote run
after push; local verification does not claim that remote execution occurred.
