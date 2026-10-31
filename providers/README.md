# Provider databases

New providers live in their own directory. Each provider keeps its scripts,
tests, and generated data separate from the others. GitHub Actions workflows
belong in `.github/workflows/` at the repository root.

`animeunity/` contains its scripts and tests. Its complete persisted snapshot,
including partial progress and caches, lives at `providers/animeunity/data/` on
`animeunity-data`. See its README for migration verification and recovery refs.

`animeworld/` is an independent provider-only scraper; see its README for the
schema, WARP-enabled workflow, validation and incremental update policy. Its
generated output uses the dedicated `animeworld-data` branch, while code stays
on `main`, so its checkpoints do not contend with AnimeUnity's publication.

`animesaturn/` follows the same independent layout and publishes only to
`animesaturn-data`. Its full archive and episode metadata checkpoints feed the
shared `unified/` catalog, which adds provider membership and enriches exclusive
works. WARP and JSON storage helpers live under `shared/`.

`streamingunity/` collects the Italian film/TV catalog, using StreamingCommunity
as a mirror fallback, and publishes only to `streamingunity-data`. It does not
feed the anime unifier. It feeds the separate `cinema/` film/TV aggregator;
global anime/cinema catalog integration remains separate.

`altadefinizione/` collects source metadata, artwork and episode inventories,
publishes only to `altadefinizione-data`, and feeds `cinema/` alongside StreamingUnity.
Each workflow has independent concurrency, checkpoints and WARP verification.
