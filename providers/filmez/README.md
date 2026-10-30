# Filmez

Independent Italian movie catalog. Outputs: providers/filmez/data/ on branch filmez-data. No push trigger; scheduled every two hours and manually selectable full/update and all/discover/details/publish stages. WARP is mandatory on GitHub. No changes to AnimeUnity data or workflows.

## Discovery and extraction

Pastebin KgQ4jTy6 resolves Eurostreaming; its /film/ page supplies the Filmez link. Candidates are validated as movie archives. Last known domain and https://filmez.club are fallbacks. Only HTTPS Filmez and Eurostreaming host families are accepted. Source pages and images use origins plus relative paths; external playback hosts remain explicit URLs, without resolving or downloading streams.

WordPress movie REST index uses 100 records per page and validates totals, unique IDs, first/last page stability and HTML archive totals before confirming coverage. HTML pagination is the fallback. Twenty requests/items is a batch size, never a catalog limit. Cursors and records survive workflow continuations. Weekly full discovery confirms omissions; only two completed omissions plus a detail 404/410 deactivate a title. Metadata stays retained for reappearance.

Modified-order feeds run every two hours. Recently changed details refresh daily, stable details weekly. Network failures retry after one hour. Detail API failures retain previous complete records; new partial records remain explicitly incomplete and retryable. Each film includes title, full plot, year, genres, country, duration, director, available cast/rating, dates, direct external IDs, poster variants, source taxonomy identifiers and playback links. Missing fields are null or empty, never invented. Related recommendations and player icons are excluded. The source does not reliably expose external IDs; title searches never automatically prove identity.

## Cinema integration

The cinema pipeline optionally loads the first Filmez snapshot, namespaces image origins, preserves playback and groups only compatible external IDs and media types. Verified identity enrichment follows the existing IMDb backlink checks; title-only candidates remain for review. Existing providers keep metadata priority. The anime/cinema global merge remains a separate future step.

## Commands and checks

- npm run filmez
- npm run verify:filmez
- npm run verify:filmez:data
- npm run verify:filmez:live
- node providers/filmez/scripts/smoke.js --archive

Live tests use temporary directories removed afterward. Full archive mode scans the index and samples ten details; it does not scrape every film locally. Tests include pagination beyond twenty requests, corrupt coverage, domain references, metadata retry preservation, cinema loading/grouping and the actual shell runner against a temporary local Git remote. GitHub secrets and hosted WARP execution require a later remote run after push.

### Duplicate source URLs

Some WordPress IDs expose the same canonical URL. The scraper accepts that page only after both authoritative REST records confirm the same URL, title and nonempty full plot. It keeps the original ID and its own featured-media variants, plus `sourceAlias.canonicalId` and an explicit warning. Conflicts remain retryable and never overwrite complete records.

Verified same-provider aliases are coalesced in cinema while preserving every source variant. This rule does not infer a match between different providers.

An attachment returning 404/410 is recorded as unavailable, preserving the page artwork; it is checked again on the next ordinary detail refresh. Temporary API/network failures instead remain incomplete and retryable.

## Verification on 2026-10-31

The full public index was scanned twice: 29,095 distinct IDs, with matching API/HTML totals. Ten evenly distributed records then passed detail extraction and export validation, including duplicate canonical URLs, API-only artwork and a deleted media attachment. The complete repository suite passed 242 tests. This verifies the index and sampled metadata, not a local scrape of all 29,095 detail pages. No GitHub workflow or push was performed.
