# Cinema SQLite publication

Code stays on `main`. `cinema-data` remains the authoritative JSON catalog.
`publish-cinema-sqlite.yml` creates `cinema-sqlite` on its first successful
publication: only `manifest.json` and a README live on that branch. Compressed
SQLite snapshots and logical deltas are immutable GitHub Release assets.
The Vega application integration is separate work on `cruncy-ui`.

## Running and activation

The Cinema update workflow explicitly dispatches the publisher after success;
a two-hour publisher schedule recovers missed dispatches and interrupted uploads.
No `push` trigger is required, since writes with `GITHUB_TOKEN` do not trigger it.
One concurrency group serializes all publications. Python 3.12 and Node 20 run
on Ubuntu. The exporter needs no provider credentials, TMDB requests or WARP.
The upstream source/enrichment workflows retain their existing WARP requirements.

The publisher fetches `cinema-data` once and pins its SHA, verifies the entire
snapshot, builds in a temporary directory, checks SQLite integrity, foreign keys,
counts and FTS, and replays any delta against the previous published database.
Source `complete: false`, pending enrichment, unknown availability or retrying
records prevent publication. It never sets `complete` artificially. An unchanged
logical revision produces no release.
Publication requires a clean committed exporter checkout. Intermediate JSON rows
are removed after their SQLite transaction commits, and the publisher releases
the extracted source tree before building SQLite to reduce peak disk usage.
Fresh snapshots do not run `VACUUM`: its temporary copy and rollback journal can
require multiple additional database-sized allocations without being necessary
for integrity. JSON-LD/schema image URLs are indexed as retained-only artwork
when their display role is not known.
The publisher also deletes the verified compressed base download and consumes
its disposable `/tmp` base when replaying the delta. This avoids a third full
SQLite copy. Ordinary CLI delta application still preserves its base via backup;
`CINEMA_SQLITE_DISPOSABLE_BASE` is set only by the publisher for its own temporary data.

Assets are uploaded to a draft release and downloaded again to check SHA-256 and
size. The release becomes public before the final fast-forward manifest push.
That push is the activation point: clients must follow the branch manifest,
**not GitHub's latest release**. A failed upload/push leaves the previous pointer
unchanged. Retrying the same source/exporter reuses verified assets; public assets
are never overwritten. Source/exporter provenance contributes to the release tag,
so an interrupted run cannot collide with a later export of the same logical data.

Manual workflow: `gh workflow run publish-cinema-sqlite.yml --ref main`.
Deploy both workflows and exporter together on `main` before activation. The first
release waits for the upstream 404 fixes and pending enrichment to complete.
An initial incomplete source is a successful skip, not a fabricated empty database.

## Schema and image contract

`PRAGMA user_version=1`. A normalized `records` table stores independent work,
season, episode, provider variant, source season, source episode, artwork and
assignment rows. IDs are namespaced (`cinema:work-N`); numbering is preserved,
including season zero and fractional episodes. Each row has a canonical JSON
payload and hash. Foreign keys enforce work, parent and artwork references.
Views `works`, `seasons`, `episodes`, `sources`, `source_seasons`,
`source_episodes`, `artworks`, `artwork_assignments`, `artwork_inventories`,
`external_ids`, `aliases` and `configurations` expose the corresponding kinds.
Each row has columns `id, kind, work_id, parent_id, artwork_id, payload, hash`.
Payload is UTF-8 JSON text. Assignment `artwork_id` joins to the artwork row whose
payload contains `url`; work and source metadata remain accessible without network.

`metadata` contains schema/reader version, logical revision, source/exporter SHAs,
counts and CDN origins for retained raw references. `search` is FTS5 with Unicode
tokenization and diacritic removal and includes only active works. Home sections
can filter work `payload.info.type`; user preferences never belong in this file.
Origins also have a configuration row so a provider domain change advances the
logical revision even when all image URLs and relative playback paths are unchanged.

Canonical fields and provider originals are separate. Full provider metadata,
composed playback references, external mappings, alias targets, artwork slots and
image relationships are retained. Exact absolute URLs are deduplicated in artwork
rows without merging distinct size URLs or losing their assignments. TVDB has no
new language/gallery collection. Covers and mobile covers remain available.

**Apps must select images only through eligible assignments**, never by scanning
raw provider payloads. Assignments contain source, field, language (null means
unknown; TMDB `xx` is no-language), scope, season/episode, rank and dimensions.
Preview URLs and unknown image roles are retained but not selectable. A forced
verified override wins over preferences. An explicit null thumbnail override
leaves no eligible episode thumbnail; it must not trigger a raw-data fallback.
Edition/source restrictions remain stronger than preferences.

| Preference | Assignment scope | Assignment field |
|---|---|---|
| Poster | work | poster |
| Background / Hero | work | background |
| Logo | work | logo |
| Season poster | season | poster |
| Episode thumbnail | episode | thumbnail |

Season/episode assignments additionally carry their canonical numbers. Repeated
inventory references to the same URL/source/scope/language are combined while
preserving every `sourcePaths` relationship and the best candidate rank.
Provider component artwork cannot become the poster of a composed container.
For scoped TMDB matches, parent-series artwork is retained but excluded from work
selection; a verified season-compilation can use the matched season's poster.

`preferences.json` is exported as a configuration row and contains the requested
defaults for each image field, work-poster fallback for seasons, shared Hero/Info
background selection, original image quality and Wi-Fi-only automatic updates.
Available settings choices are derived from eligible assignments; changing them
does not require regenerating the SQLite file. TMDB size changes must preserve
the stored original URL; TVDB/provider URLs and SVG images stay unchanged. The
versioned `tmdbSizes` capability lists can be refreshed from TMDB configuration
when implementing the app reader; no new metadata requests are made by this exporter.
Resolve `tmdb:original` from the inventory's original language (the primary BCP-47
language subtag); deduplicate a language already tried. Within a language retain
candidate rank. If all allowed choices are unavailable/disabled, use the explicit
season-to-work fallback or a placeholder, never an arbitrary raw provider image.

## Incremental updates

Each release has a full `cinema.sqlite.gz`. When compatible with the last published
schema it also has `delta.ndjson.gz`, containing a header with base revision and
target metadata, followed by row upserts/deletions. Changing one episode does not
resend an entire series. Deltas compare exported records with the **published
SQLite**, not batch `changes.json`. Search indexes are rebuilt after applying rows.
An upsert is `{"upsert":[id,kind,work_id,parent_id,artwork_id,payload,hash]}`;
a deletion is `{"delete":id}`. IDs are opaque; consumers must not reconstruct
provider playback coordinates by parsing them.
The row hash is SHA-256 of the compact JSON array containing its first six columns
(payload stays a JSON **string** in that array). The logical revision hashes UTF-8
`cinema-schema-1` followed by each hexadecimal row hash ordered by record ID.
Delta replay compares this logical revision, not the byte checksum of a freshly
built snapshot, since equivalent SQLite files can have different page layouts.

The current manifest advertises at most 100 contiguous delta edges, including
their original immutable release URLs. Starting at the installed revision, follow
matching `fromRevision` / `toRevision` edges to the target. Use the chain only when
complete and its total compressed size is cheaper than the snapshot. Otherwise
download the full snapshot. Historical releases are retained; traversal is bounded.
A schema mismatch also requires a full supported snapshot. Skipping one ordinary
update therefore does not force another multi-gigabyte installation download.
When a content revision occurs more than once (a later revert), start at the most
recent matching `fromRevision` and then consume the remaining entries in array
order, rather than following an unordered map that could revisit an old cycle.

Verify compressed size/checksum before decompression, verify the uncompressed
snapshot checksum, and reject unsupported schema/reader versions. SHA-256 protects
integrity; there is no detached signature or independent signing-key trust model.
`database.py apply BASE DELTA OUTPUT` uses SQLite's backup API (WAL safe), a separate
staging file, one transaction, hashes and integrity checks before atomic activation
of the output. It refuses an existing output or incorrect base and preserves the
input database after failures. App-side installation must provide equivalent checks.

## Local verification

Run `npm run verify:cinema:sqlite`, `npm run verify:streamingunity` and
`npm run verify:all`. Export a pinned, already verified checkout with:

```
node cinema/sqlite/export.js INPUT_DATA NEW_OUTPUT SOURCE_SHA EXPORTER_SHA [PREVIOUS_SQLITE]
python -B cinema/sqlite/database.py verify NEW_OUTPUT/cinema.sqlite
```

Use a fresh output directory. Python 3.10+ suffices for local export/tests; only
the publisher's safe tar extraction requires Python 3.12. The optional
`CINEMA_SQLITE_VALIDATION_ONLY=1` permits benchmarking an incomplete snapshot,
marks it `validationOnly: true`, and is explicitly rejected by the publisher.
It cannot be used as the base of a published delta. Generated files belong under
ignored `.cache/`; no SQLite binaries, downloaded snapshots or secrets enter Git.

### Real-catalog validation, 2026-11-11

Source commit `395350c011ede98ed8001394c06946a1de6ba320` was exported locally in
validation-only mode: 19,290 works (19,275 active), 123,277 canonical episodes and
2,003,866 distinct image URLs. Full source hash checks, image-reference coverage,
SQLite integrity/foreign keys, row hashes and FTS passed. Real Spidey overrides,
Power Rangers container artwork and black-and-white edition restrictions were
also checked. The source was incomplete, so this was **not a publishable release**.

Measured snapshot size: 4,628,811,776 bytes uncompressed and 1,273,739,739 bytes
gzip-compressed. These are metadata and URL records, not downloaded image files.
The app installer must budget storage for its installed catalog and a staged
replacement; retaining 100 delta edges avoids a full download for every missed run.
