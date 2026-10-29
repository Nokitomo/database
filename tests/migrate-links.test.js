'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {hash, readJson, writeJson} = require('../scripts/lib');
const {migrateLinks} = require('../scripts/migrate-links');

test('link migration is dry by default, then rebuilds final hashes without scraping', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-link-migration-'));
  const dataRoot = path.join(root, 'anime_database');
  const providerRefPath = path.join(root, 'vega-providers.ref');
  const item = stage => path.join(dataRoot, stage, 'items', '7.json');
  try {
    fs.writeFileSync(providerRefPath, 'provider-a\n');
    const source = {expectedIds: [7], baseUrl: 'https://www.animeunity.co', complete: false, errors: {}};
    const mappingIndex = {providerRef: 'provider-a', sourceHash: 'anibridge-a', complete: false, errors: {}};
    const raw = {id: 7, path: '/anime/7-main', fingerprint: 'raw-a', info: {}, episodes: []};
    const mapped = {id: 7, rawFingerprint: 'raw-a', providerRef: 'provider-a', mappingSourceHash: 'anibridge-a'};
    const final = {id: 7, path: '/anime/7-main', updatedAt: new Date().toISOString(),
      info: {title: 'Main', related: [{link: 'https://www.animeunity.co/anime/8-related',
        image: 'https://img.animeunity.co/anime/8.jpg', variants: [
          {link: 'https://www.animeunity.co/anime/9-dubbed'}]}]},
      episodes: [], sourceEpisodes: [], rawFingerprint: 'raw-a',
      mappingFingerprint: hash(mapped), providerRef: 'provider-a'};
    writeJson(path.join(dataRoot, 'raw', 'index.json'), source);
    writeJson(path.join(dataRoot, 'mapped', 'index.json'), mappingIndex);
    writeJson(path.join(dataRoot, 'final', 'manifest.json'), {providerRef: 'provider-a', errors: {}});
    writeJson(item('raw'), raw);
    writeJson(item('mapped'), mapped);
    writeJson(item('final'), final);
    const before = fs.readFileSync(item('final'), 'utf8');
    assert.equal(migrateLinks({dataRoot, providerRefPath}).changed, 1);
    assert.equal(fs.readFileSync(item('final'), 'utf8'), before);
    assert.equal(migrateLinks({apply: true, dataRoot, providerRefPath}).changed, 1);
    const migrated = readJson(item('final'));
    assert.equal(migrated.info.related[0].link, '/anime/8-related');
    assert.equal(migrated.info.related[0].variants[0].link, '/anime/9-dubbed');
    assert.equal(migrated.info.related[0].image, final.info.related[0].image);
    assert.equal(migrated.linkSchemaVersion, 2);
    assert.deepEqual(migrated.info.extra.artworkFallbacks, {logo: [], poster: [], background: []});
    const manifest = readJson(path.join(dataRoot, 'final', 'manifest.json'));
    assert.equal(manifest.availableCount, 1);
    assert.equal(manifest.itemHashes[7], hash(migrated));
    assert.equal(readJson(path.join(dataRoot, 'final', 'catalog.json')).records.length, 1);
    assert.equal(migrateLinks({apply: true, dataRoot, providerRefPath}).changed, 0);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('migration includes stale and archived final records without changing their refresh state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-stale-link-migration-'));
  const dataRoot = path.join(root, 'anime_database');
  const providerRefPath = path.join(root, 'vega-providers.ref');
  try {
    fs.writeFileSync(providerRefPath, 'current-provider\n');
    writeJson(path.join(dataRoot, 'raw/index.json'), {expectedIds: [7], complete: true});
    writeJson(path.join(dataRoot, 'mapped/index.json'), {providerRef: 'current-provider', sourceHash: 'new', complete: true});
    writeJson(path.join(dataRoot, 'final/manifest.json'), {providerRef: 'current-provider', errors: {}});
    writeJson(path.join(dataRoot, 'raw/items/7.json'), {id: 7, path: '/anime/7-new-slug', fingerprint: 'new'});
    writeJson(path.join(dataRoot, 'mapped/items/7.json'), {id: 7, providerRef: 'current-provider',
      rawFingerprint: 'new', mappingSourceHash: 'new'});
    const old = {id: 7, path: 'https://www.animeunity.co/anime/7-old-slug',
      providerRef: 'old-provider', rawFingerprint: 'old', mappingFingerprint: 'old', updatedAt: '2020-01-01',
      info: {title: 'Old', poster: 'https://img.animeunity.co/anime/7.jpg', related: [
        {link: 'https://www.animeunity.co/anime/8-related', variants: [
          {link: 'https://www.animeunity.co/anime/9-dubbed'}]}]},
      episodes: [{link: '123', title: 'Episode', thumbnail: 'https://image.tmdb.org/t/p/original/episode.jpg'}],
      sourceEpisodes: []};
    const filename = path.join(dataRoot, 'final/items/7.json');
    const archived = path.join(dataRoot, 'final/items/99.json');
    writeJson(filename, old);
    writeJson(archived, {...old, id: 99, path: '/anime/99-archived'});
    const result = migrateLinks({apply: true, dataRoot, providerRefPath});
    assert.equal(result.scanned, 2);
    assert.equal(result.changed, 2);
    const migrated = readJson(filename);
    assert.equal(migrated.path, '/anime/7-old-slug');
    assert.equal(migrated.info.related[0].link, '/anime/8-related');
    assert.equal(migrated.info.related[0].variants[0].link, '/anime/9-dubbed');
    for (const key of ['providerRef', 'rawFingerprint', 'mappingFingerprint', 'updatedAt'])
      assert.equal(migrated[key], old[key]);
    assert.deepEqual(migrated.episodes, old.episodes);
    assert.equal(migrated.info.poster, old.info.poster);
    assert.equal(readJson(archived).info.related[0].link, '/anime/8-related');
    const manifest = readJson(path.join(dataRoot, 'final/manifest.json'));
    assert.deepEqual(manifest.pendingRefreshIds, [7]);
    assert.equal(manifest.availableCount, 1);
    assert.equal(manifest.complete, false);
    assert.equal(readJson(path.join(dataRoot, 'final/catalog.json')).records[0].path, '/anime/7-old-slug');
    assert.equal(readJson(path.join(dataRoot, 'final/shards/07.json')).records[0].info.related[0].link, '/anime/8-related');
    assert.equal(migrateLinks({apply: true, dataRoot, providerRefPath}).changed, 0);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
