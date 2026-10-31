# Database contract for Vega

Schema version: `1`. All paths below are relative to this repository.

## Identity and files

AnimeUnity's numeric anime ID is the primary key. Its episode ID is the
episode key. Domain-independent paths such as `/anime/4354-ippon-again/` are
stored alongside a snapshot base URL. Consumers resolve AnimeUnity paths
against their current `getBaseUrl("animeunity")` result.

| File | Contents |
| --- | --- |
| `providers/animeunity/data/raw/index.json` | Discovered IDs, archive/sitemap totals, source base URL, completeness and errors. |
| `providers/animeunity/data/raw/items/{id}.json` | Full AnimeUnity info API payload, embedded page metadata, archive record and episode payloads. |
| `providers/animeunity/data/mapped/items/{id}.json` | All AniBridge/AniZip IDs, direct metadata targets, scoped mappings and ranges. |
| `providers/animeunity/data/final/items/{id}.json` | Vega `Info`, `EpisodeLink[]`, source payloads, mapping provenance and all discovered artwork URLs. |
| `providers/animeunity/data/final/catalog.json` | Compact cards and sorting/filtering data for archive, home, search and calendar. |
| `providers/animeunity/data/final/shards/{00..99}.json` | Download groups; each contains Vega `Info` and `EpisodeLink[]` records whose ID modulo 100 matches the shard name. |
| `providers/animeunity/data/final/manifest.json` | Schema, provider revision, counts, complete flag and hashes for incremental downloads. |

The final `info` object uses the provider's `Info` shape. `episodes` use its
`EpisodeLink[]` shape. `info.extra.artworkCandidates` contains only sources
currently accepted by the Vega type. `artworkInventory` also contains AniList
banner and poster candidates. Image URLs are references, not copied images.

The final `Info` is a snapshot. Provider-origin URLs within it, including
related-title links, should be rewritten against the current AnimeUnity base
URL when served to Vega. External CDN URLs stay unchanged. The producer keeps
the original provider payload so that this transformation can be revisited.

## Publication and updates

The pipeline writes each record atomically. It never replaces a successful
record with a failed request. A manifest becomes `complete: true` only after
every discovered ID has a current raw, mapped and final record. A consumer
should use only a complete manifest and verify its hashes before promoting a
downloaded generation. It should retain its previous complete generation on
network or validation failure.

For a first install, download the catalog and shards. On later runs, compare
`itemHashes` or `shardHashes` with the installed manifest and fetch only changes.
The current checkout does not yet contain the Vega consumer implementation;
that belongs to the separate `vega-providers` and `vega-app` repositories.

## Provider runtime behavior after integration

1. `getPosts` filters and sorts local catalog cards and resolves their paths
   against the current AnimeUnity domain.
2. `getMeta` returns local `Info` immediately. For ongoing or upcoming anime,
   it runs the provider's existing `getContentInventory` live. A changed status
   or episode count triggers the same `getMeta`/`getEpisodes` enrichment path
   used today and stores a local overlay keyed by anime ID.
3. `getEpisodes` returns local episodes immediately. On a live refresh, it runs
   the provider's existing `getEpisodeInventory`, compares episode IDs, and
   enriches only new or changed episodes. An incomplete inventory is an error,
   not an instruction to remove previously saved episodes.
4. `getStream` remains live and resolves the selected provider episode ID at
   playback time. Expiring stream URLs are never stored in this database.

The GitHub workflow rebuilds these snapshots on a schedule, so installed
clients can receive the next complete generation even when a title is never
opened live.
