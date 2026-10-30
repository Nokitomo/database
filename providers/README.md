# Provider databases

New providers live in their own directory. Each provider keeps its scripts,
tests, and generated data separate from the others. GitHub Actions workflows
belong in `.github/workflows/` at the repository root.

AnimeUnity remains in the existing root-level `scripts/`, `tests/`, and
`anime_database/` directories while its current database build continues.
It can be moved into this layout after that build is complete.

The `animeworld/` directories are reserved for the next provider. Its source
resolution, WARP-enabled workflow, data format, and update policy will be
implemented when those requirements are defined.
