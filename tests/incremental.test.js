'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {hash, writeJson} = require('../scripts/lib');
const {mappingFingerprint, migrateFinalMapping, matchesMapping, consumerContent} = require('../scripts/incremental');
const {refreshPlan, ENRICHMENT_SCHEMA_VERSION} = require('../scripts/incremental');
const {rebuildFinalArtifacts} = require('../scripts/pipeline');
const {mappingDue} = require('../scripts/pipeline');
const {enrichAnime} = require('../scripts/vega');

const mapped = () => ({id: 1, sourceIds: {anilistId: 10}, ids: {tmdbShowIds: [20]},
  metadataTargets: [{provider: 'tmdb_show', id: '20'}], mappings: {generatedOn: 'old',
    targets: [{provider: 'tmdb_show', id: '20', scope: 'season:1', ranges: {'1-12': '1-12'}}]},
  mappedAt: 'old', providerRef: 'v1', mappingSourceHash: 'global-old'});

test('global AniBridge update and control timestamps do not change effective mapping', () => {
  const before = mapped();
  const after = {...before, mappingSourceHash: 'global-new', checkedAt: 'now', mappedAt: 'now',
    mappings: {...before.mappings, generatedOn: 'new'}};
  assert.equal(mappingFingerprint(before), mappingFingerprint(after));
  const final = {mappingFingerprint: hash(before), updatedAt: 'old', info: {title: 'Anime'}};
  const migrated = migrateFinalMapping(final, before, after);
  assert.equal(migrated.updatedAt, 'old');
  assert.equal(matchesMapping(migrated, after), true);
  assert.equal(hash(consumerContent(final)), hash(consumerContent(migrated)));
});

test('ID changes, mapping removals and episode range changes invalidate effective mapping', () => {
  const before = mapped();
  for (const after of [
    {...before, imdbId: 'tt123'},
    {...before, metadataTargets: []},
    {...before, mappings: {targets: []}},
    {...before, mappings: {targets: [{...before.mappings.targets[0], ranges: {'1-12': '13-24'}}]}},
  ]) assert.notEqual(mappingFingerprint(before), mappingFingerprint(after));
});

test('publication retains a coherent old anime while changed mapping is being enriched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-incremental-'));
  try {
    const old = mapped();
    writeJson(path.join(root, 'raw/items/1.json'), {fingerprint: 'raw', path: '/anime/1-test'});
    writeJson(path.join(root, 'mapped/items/1.json'), {...old, mappingSourceHash: 'new'});
    const final = {id: 1, path: '/anime/1-test', info: {title: 'Anime', extra: {}}, episodes: [],
      providerRef: 'v1', rawFingerprint: 'raw', mappingFingerprint: hash(old)};
    writeJson(path.join(root, 'final/items/1.json'), final);
    const manifest = rebuildFinalArtifacts({expectedIds: [1], complete: true},
      {complete: false, sourceHash: 'new'}, {errors: {}}, 'v1', root);
    assert.equal(manifest.availableCount, 1);
    assert.equal(manifest.complete, false);
    assert.deepEqual(manifest.pendingRefreshIds, [1]);
    assert.equal(manifest.contentHashes[1], hash(consumerContent(final)));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('artwork-only refresh reuses episodes but expired episode tasks and schema migration do not', () => {
  const mapping = mapped();
  const raw = {fingerprint: 'raw', path: '/anime/1'};
  const now = Date.now();
  const final = {rawFingerprint: 'raw', path: raw.path, mappingFingerprintVersion: 2,
    mappingFingerprint: mappingFingerprint(mapping), updatedAt: new Date(now).toISOString(),
    enrichmentSchemaVersion: ENRICHMENT_SCHEMA_VERSION, episodes: [], metadataTasks: {
      episodes: {kind: 'episodes', nextCheckAt: now + 10000},
      artwork: {kind: 'image-language', nextCheckAt: now - 1},
    }};
  assert.equal(refreshPlan(final, raw, mapping, now).reuseEpisodes, true);
  assert.equal(refreshPlan(final, raw, mapping, now).reuseInfo, false);
  assert.deepEqual(Object.keys(refreshPlan(final, raw, mapping, now).retainedTasks), ['episodes']);
  assert.equal(refreshPlan(final, raw, mapping, now + 20000).reuseEpisodes, false);
  assert.equal(refreshPlan({...final, enrichmentSchemaVersion: undefined}, raw, mapping, now).reason, 'schema-backfill');
  assert.equal(refreshPlan({...final, enrichmentSchemaVersion: undefined}, raw, mapping, now).reuseEpisodes, false);
  assert.equal(refreshPlan(final, {...raw, fingerprint: 'new'}, mapping, now).reuseEpisodes, false);
});

test('consumer hash excludes global AniBridge publication date inside info', () => {
  const a = {info: {title: 'Anime', extra: {mappings: {generatedOn: 'before', targets: []}}}};
  const b = structuredClone(a);
  b.info.extra.mappings.generatedOn = 'after';
  assert.equal(hash(consumerContent(a)), hash(consumerContent(b)));
  assert.equal(a.info.extra.mappings.generatedOn, 'before');
});

test('full continuation advances after checking an unchanged mapping', () => {
  const raw = {fingerprint: 'same'};
  const previous = {rawFingerprint: 'same', providerRef: 'v1', mappingSourceHash: 'index',
    mappedAt: '2020-01-01T00:00:00Z', checkedAt: '2026-10-29T00:00:00Z'};
  assert.equal(mappingDue(raw, previous, 'v1', 'index', true, Date.parse('2026-10-28')), false);
});

test('episode checkpoint survives a later artwork failure', async () => {
  const raw = {id: 1, path: '/anime/1', info: {}, episodes: [{id: 10, number: '1'}]};
  const mapping = {sourceIds: {}, mappings: {targets: []}};
  let checkpoint;
  let episodeCalls = 0;
  const options = {getMeta: async () => ({title: 'Test', linkList: [{episodesLink: '1|1|1'}]}),
    getEpisodes: async () => {episodeCalls++; return [{link: '10', title: 'Episode'}];},
    fillTvdbEpisodeGaps: async () => {}, checkpoint: value => {checkpoint = structuredClone(value);},
    collectArtwork: async () => {throw new Error('Artwork interrupted');}};
  await assert.rejects(enrichAnime('.', 'https://www.animeunity.co', raw, mapping, options), /Artwork interrupted/);
  assert.equal(checkpoint.nextGroup, 1);
  const result = await enrichAnime('.', 'https://www.animeunity.co', raw, mapping,
    {...options, progress: checkpoint, collectArtwork: async () => ({poster: [], logo: [], background: []})});
  assert.equal(episodeCalls, 1);
  assert.equal(result.episodes.length, 1);
});

test('an aborted group is not checkpointed as complete', async () => {
  const controller = new AbortController();
  let checkpoints = 0;
  const raw = {id: 1, path: '/anime/1', info: {}, episodes: [{id: 10, number: '1'}]};
  await assert.rejects(enrichAnime('.', 'https://www.animeunity.co', raw, {sourceIds: {}}, {
    signal: controller.signal,
    getMeta: async () => ({title: 'Test', linkList: [{episodesLink: '1|1|1'}]}),
    getEpisodes: async () => {controller.abort(); return [];},
    fillTvdbEpisodeGaps: async () => {}, collectArtwork: async () => ({}),
    checkpoint: () => {checkpoints++;},
  }), {name: 'AbortError'});
  assert.equal(checkpoints, 0);
});
