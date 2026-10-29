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
