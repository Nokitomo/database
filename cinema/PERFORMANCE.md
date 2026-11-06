# Cinema pipeline performance investigation — 2026-11-06

Code baseline: `104101104941896a9442fdf6b68848c2411b4c9f` (main).

## Live evidence

[Run #4](https://github.com/Nokitomo/database/actions/runs/42164310971) was still in progress when checked around 08:50 CET, in “Merge and enrich with durable checkpoints”. Run #3 completed successfully. The manifest fetched earlier reported 19,204 active records, pendingCount 18,160 and complete false. The last batch visible in the job log at 08:44:35 CET reported pendingCount 18,150, processed 10; verification completed at 08:45:04. This is ongoing progress, not a stuck merge-only run.

The last nine inter-batch intervals in the retrieved log were 156–192 seconds for ten titles. Recent full verification passes took roughly 29 seconds. These intervals include pipeline, verification, synchronization and Git operations; they do not isolate external-request latency. There was no per-phase pipeline timing in the old log, so attributing the remainder to either APIs or local hashing would be speculative.

## Repeated work and changes

1. Source verification already reads every item and shard and checks their hashes. `loadSources` then read every item again. Optional `onRecord` callbacks now retain those verified records, eliminating the second item read/parse. All verification checks still execute and any failure aborts source loading.
2. Publication reads and hashes all retained cinema items to detect corruption. This safety check remains. It then hashed every new item, serialized/read-compared every item and serialized/hashed all 100 shards. Publication now computes the changed item set, skips unchanged item writes and only rebuilds affected or missing shards. Unchanged shard hashes are reused. The existing **full cinema verification before rsync/commit/push remains mandatory**, including skipped shards. A corrupt retained item fails publication; a corrupt skipped shard fails verification and cannot be pushed. Missing shards are rebuilt. No persistent verification cache is trusted across processes.
3. Coverage contained a new timestamp on every batch, forcing a coverage/manifest update even with identical records. Unchanged coverage is now verified and reused for at most one day; changed records regenerate it immediately. The consumer's existing seven-day freshness limit remains unchanged. `changes.json` still transitions from the previous changed list to an empty list as before.
4. The default title cap rises from 10 to 100 within the same 180-second budget, amortizing whole-catalog loading/publication/verification/Git work when titles complete quickly. It is a ceiling, not a target: the deadline still stops new work. `CINEMA_BATCH_LIMIT=10` restores the previous cap; `CINEMA_BUDGET_MS` controls the existing budget. Requests remain sequential, using the existing pacing, timeout, WARP and external caches. Identity lookup uses the same cap and shared deadline as before, independently of the enrichment count. This does not imply a 10× throughput improvement.
5. Draft saves and state writes after each attempted title remain unchanged. Retry backoff, fingerprint invalidation, retained identities, membership, migrations and continuation dispatch remain in place. A larger batch can increase the number of newly completed titles between remote checkpoints, but local per-title checkpoints remain and the same time budget bounds processing. Whole-catalog publication/verification costs are outside the enrichment deadline, as before.

`CINEMA_BATCH.timings` reports source loading, identity, grouping, assembly, enrichment, state checkpoint and publication times. Merge/fingerprint/enriched-read times are breakdowns of assembly time and should not be added to it. Enrichment timing includes draft/cache writes, not just HTTP latency. `CINEMA_CHECKPOINT` reports pipeline, verification, synchronization/WARP and Git wall times in seconds.

## Offline benchmark

Node v24.22.1 on this workspace; medians of three runs per variant, alternating baseline/optimized. The real sample is shard `00` (blob `54ba4f67d940129112e0388add94e16c2e4eacf9`): 192 records, approximately 6.1 MB. The synthetic fixture has 19,204 deliberately smaller movie records. These are publication-only timings; every benchmark publication is followed by the real verifier outside the timed region. No external API calls are made. These results are not full-catalog production throughput estimates; Actions uses Node 20.

| Fixture / operation | Before | After | Improvement |
|---|---:|---:|---:|
| Real shard, initial publication | 391 ms | 401 ms | −2.6% |
| Real shard, unchanged | 330 ms | 153 ms | 53.6% |
| Real shard, ten titles changed | 360 ms | 287 ms | 20.3% |
| Synthetic 19,204, initial publication | 3,670 ms | 3,502 ms | 4.6% |
| Synthetic 19,204, unchanged | 1,283 ms | 762 ms | 40.6% |
| Synthetic 19,204, ten changed | 1,295 ms | 953 ms | 26.4% |

For unchanged synthetic publication, reads fell from 38,515 / 60.6 MB to 19,212 / 32.3 MB. Bytes written fell from 6.47 MB to 28 bytes (the first empty `changes.json`; later unchanged publications need no timestamp-only write within the coverage refresh window). When ten titles change, coverage still regenerates; bytes written remain unchanged by this optimization. The real sample's ten updated records share one shard, so its shard must still be rebuilt.

Reproduce on the current implementation:

```sh
node cinema/scripts/benchmark.js
node cinema/scripts/benchmark.js /path/to/cinema-shard.json
```

To compare with another revision, copy that revision's `catalog.js` alongside the script and set `BENCH_CATALOG_MODULE=./catalog-baseline`; remove the temporary file afterward. `BENCH_COUNT` controls synthetic fixture size.

## Regression validation and remaining costs

33 cinema tests and 74 affected-provider tests passed, covering source reads, corruption, missing shards, dirty shard hashes, default/explicit limits, deadlines, merge-only mode, drafts/backoff/restart, unchanged coverage, coverage refresh/corruption, legacy identity splits and real runner branch/checkpoint integration. A further 18 provider-runner and coverage checks passed (plus a repeated cinema-runner check). Provider verification defaults remain backward compatible.

Full source verification, grouping, base merging, per-title fingerprints, cached enrichment reads, retained-item validation, final full verification, rsync and Git still scale with the whole catalog. This patch deliberately does not introduce a persistent cache for those decisions. Use the new timings on a subsequent real run to identify the dominant remaining cost before considering a long-lived worker or a more invasive incremental merge. The active run was not cancelled, restarted or modified by this investigation.
