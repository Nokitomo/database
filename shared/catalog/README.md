# Selective secondary-provider collection

AnimeUnity and StreamingUnity keep their complete collection pipelines. AnimeWorld,
AnimeSaturn, AnimeTop, Altadefinizione, Eurostreaming and Filmez always scan their
own complete archives, but use verified primary coverage to avoid redundant detail
requests. The existing retirement rules remain authoritative for availability.

## Coverage and identity

The anime and cinema publishers export `coverage.json` alongside the final
manifest. Its hash is included in the manifest and checked by the export verifier.
It contains primary-present works, external IDs, media types, metadata coverage,
episode counts and already verified secondary-provider memberships. It contains
no stream URLs and does not replace source snapshots or the application catalog.

Each secondary workflow downloads the corresponding file from `unified-data` or
`cinema-data` through WARP. Missing, stale (over seven days), corrupt or wrong-kind
coverage causes complete collection. This also supports initial bootstrapping and
old branches without the new file. No additional secret is needed: the workflow
uses its repository token. On the first run before coverage exists, some redundant
collection is expected; later runs can use the newly published coverage.

Matching requires a unique compatible external identity, or an existing verified
provider-ID membership whose path, title, type and available year still agree.
Title equality alone never creates a match. Conflicting IDs, ambiguous matches,
unknown cinema media types, missing primary title/plot/poster/background/episode
metadata or additional episodes on the secondary provider require full collection.
Anime IDs already identify an anime independently of an unknown format label.

## Collection behavior

- First/changed identities may still require the main page because archive cards
  often do not expose external IDs. Unknown or exclusive works collect all source
  metadata as before and follow the existing unifier enrichment pipeline.
- Covered AnimeWorld titles omit the supplementary tooltip. Covered AnimeSaturn
  titles omit individual episode-page requests. Covered Filmez titles omit the
  supplementary detail/media REST calls. Covered Eurostreaming titles can omit
  the connected episode page. Metadata already on a fetched page is retained.
- All six providers can reuse a covered existing record without requesting its
  page again when archive/feed identity is unchanged. Identity is rechecked at
  least when seven days have elapsed and the record is due. Archive updates,
  omission confirmation, changed paths and forced refresh bypass this reuse.
- A coverage revision that no longer covers a linked record queues full detail
  collection, including when the primary provider disappears or loses metadata.
- Existing artwork, tooltip data and matching episode metadata are retained when
  supplementary requests are intentionally omitted. Source references keep their
  existing domain-independent format.

`record.collection.mode` is `linked` or `full`; linked records name the primary
work and its metadata fingerprint. Source `complete` means all tasks required by
the selected policy finished, not that every secondary endpoint was fetched.
Application consumers continue to use the final enriched catalog. Direct users
of source snapshots must respect the collection marker.

## Compatibility and scope

No source branch, canonical ID, publication path or workflow trigger is renamed.
Existing full snapshots remain readable. Primary scrapers and playback resolution
are unchanged. Anime/cinema cross-catalog unification and Vega's database download
implementation remain separate work; this change optimizes source collection.

Tests cover all six adapters, missing/expired/corrupt coverage, exact and conflicting
IDs, membership changes, additional episodes, retained artwork, restoration of full
collection, the coverage downloader and the existing regression suite. Mocked
requests assert which endpoint calls occur; no production scraper is launched by
these tests.

Provider-reported changes trigger full collection for that record, including
connected episode pages, even when its identity is already covered. Episode
coordinates are compared as well as counts: season zero and fractional episodes
cannot silently disappear behind a matching total. Failed or partial records
cannot be promoted to complete through cached reuse.
