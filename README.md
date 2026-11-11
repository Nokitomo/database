# Provider databases

Source code and workflows live on main. Provider snapshots and checkpoints live
on independent data branches; scraping runs do not update the code checkout.

| Provider | Code | Data branch |
|---|---|---|
| AnimeUnity | providers/animeunity | animeunity-data |
| StreamingUnity | providers/streamingunity | streamingunity-data |
| AnimeWorld | providers/animeworld | animeworld-data |
| AnimeSaturn | providers/animesaturn | animesaturn-data |
| AnimeTop | providers/animetop | animetop-data |
| Altadefinizione | providers/altadefinizione | altadefinizione-data |
| Eurostreaming | providers/eurostreaming | eurostreaming-data |
| Filmez | providers/filmez | filmez-data |

Each snapshot uses providers/<provider>/data on its data branch. AnimeUnity's
snapshot additionally contains raw, mapped and final stages and persistent caches.
See [AnimeUnity migration and recovery](providers/animeunity/README.md).

Anime and cinema unifiers publish to unified-data and cinema-data respectively.
They read committed source snapshots; the global anime/cinema merger and Vega
client download integration remain separate work.

The [Cinema SQLite publisher](cinema/sqlite/README.md) exports verified complete
`cinema-data` snapshots to GitHub Releases, with a version pointer on
`cinema-sqlite`. It is dispatched after Cinema updates and checks every two hours
for recovery. Incomplete snapshots never replace the published version.

Secondary-provider schedules are currently paused; manual workflows remain
available. Cinema has its own two-hour scheduler. AnimeUnity activation is
controlled in GitHub during migration.
StreamingUnity continues independently. All network scraping workflows require
Cloudflare WARP. Run npm run verify:all for the full regression suite.
