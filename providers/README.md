# Provider databases

New providers live in their own directory. Each provider keeps its scripts,
tests, and generated data separate from the others. GitHub Actions workflows
belong in `.github/workflows/` at the repository root.

AnimeUnity remains in the existing root-level `scripts/`, `tests/`, and
`anime_database/` directories while its current database build continues.
It can be moved into this layout after that build is complete.

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
feed the anime unifier. Future film/TV aggregation and global catalog integration
are separate pipelines; see its README for archive coverage guarantees.
