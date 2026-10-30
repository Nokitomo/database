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
