'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {writeJson, readJson, hash} = require('../scripts/lib');
const {maintainImages, applyImageReplacements, probeImage} = require('../scripts/image-health');
const {rebuildFinalArtifacts} = require('../scripts/pipeline');
const OLD = 'https://img.animeunity.co/anime/old.jpg';
const NEW = 'https://img.animeunity.example/anime/new.jpg';
const EXTERNAL = 'https://image.tmdb.org/t/p/original/image.jpg';
const NOW = 1800000000000;

function fixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-health-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const item = id => path.join(root, 'final/items', `${id}.json`);
  for (let id = 1; id <= count; id++) writeJson(item(id), {id, path: `/anime/${id}-test`,
    updatedAt: '2020-01-01', rawFingerprint: 'raw', mappingFingerprint: 'mapped',
    info: {title: 'Test', poster: OLD, background: EXTERNAL}, episodes: [],
    artworkInventory: {poster: [{source: 'provider', url: OLD}]},
    sourceMetadata: {info: {id, imageurl: OLD}}, sourceEpisodes: []});
  return {root, item};
}
function options(root, extra = {}) {
  return {root, now: NOW, log: () => {}, discoverBase: async () => 'https://www.animeunity.example',
    fetchInfo: async (_base, id) => ({id, imageurl: NEW}), ...extra};
}

test('healthy sample is limited and daily; external images are never probed', async t => {
  const {root} = fixture(t, 12);
  const calls = [];
  const opts = options(root, {probe: async url => {calls.push(url); return true;},
    discoverBase: async () => {throw new Error('Should not discover');}});
  assert.equal((await maintainImages(opts)).checked, 5);
  assert.deepEqual(calls, Array(5).fill(OLD));
  assert.equal((await maintainImages({...opts, now: NOW + 1000})).checked, 0);
  assert.equal(calls.length, 5);
});

test('verified provider URL repairs final images and artifacts, retaining metadata provenance', async t => {
  const {root, item} = fixture(t);
  const before = readJson(item(1));
  const result = await maintainImages(options(root, {probe: async url => url === NEW}));
  assert.equal(result.changed, 1);
  const after = readJson(item(1));
  assert.equal(after.info.poster, NEW);
  assert.equal(after.info.background, EXTERNAL);
  assert.equal(after.artworkInventory.poster[0].url, NEW);
  assert.equal(after.info.extra.artworkFallbacks.poster[0].url, NEW);
  for (const key of ['updatedAt', 'rawFingerprint', 'mappingFingerprint', 'sourceMetadata', 'episodes'])
    assert.deepEqual(after[key], before[key]);
  const state = readJson(path.join(root, 'image-health.json'));
  assert.equal(state.replacements[OLD].url, NEW);
  assert.equal(applyImageReplacements(before, state.replacements).info.poster, NEW);
  const manifest = rebuildFinalArtifacts({expectedIds: [1], complete: false}, {complete: false},
    {errors: {}}, 'ref', root);
  assert.equal(manifest.itemHashes[1], hash(readJson(item(1))));
  assert.equal(readJson(path.join(root, 'final/catalog.json')).records[0].image, NEW);
  assert.equal(readJson(path.join(root, 'final/shards/01.json')).records[0].info.poster, NEW);
});

test('temporary errors and unverified new URLs never replace or delete existing images', async t => {
  const {root, item} = fixture(t);
  const before = fs.readFileSync(item(1), 'utf8');
  const result = await maintainImages(options(root, {probe: async () => false}));
  assert.equal(result.changed, 0);
  assert.equal(fs.readFileSync(item(1), 'utf8'), before);
  const state = readJson(path.join(root, 'image-health.json'));
  assert.deepEqual(state.replacements, {});
  assert(state.pending[1].nextCheckAt > NOW);
  assert.equal((await maintainImages(options(root, {now: NOW + 1000,
    probe: async () => {throw new Error('Should wait');}}))).checked, 0);
});

test('changed episode image paths are matched using the source episode ID', async t => {
  const {root, item} = fixture(t);
  const record = readJson(item(1));
  record.info.poster = EXTERNAL;
  record.artworkInventory = {};
  record.sourceMetadata.info.imageurl = EXTERNAL;
  record.episodes = [{link: '10', title: 'Title', thumbnail: OLD}];
  record.sourceEpisodes = [{id: 10, number: '2', image: OLD}];
  writeJson(item(1), record);
  let calls = 0;
  const result = await maintainImages(options(root, {probe: async url => url === NEW,
    fetchEpisode: async (_base, id, number) => {
      calls++; assert.equal(id, 1); assert.equal(number, 2);
      return [{id: 99, image: EXTERNAL}, {id: 10, image: NEW}];
    }}));
  assert.equal(result.changed, 1);
  assert.equal(calls, 1);
  assert.equal(readJson(item(1)).episodes[0].thumbnail, NEW);
  assert.equal(readJson(item(1)).sourceEpisodes[0].image, OLD);
});

test('probe rejects HTML and falls back to a bounded ranged GET when HEAD fails', async () => {
  const calls = [];
  assert.equal(await probeImage(OLD, undefined, async (method, _url, _signal, extra) => {
    calls.push(method);
    if (method === 'head') throw new Error('HEAD unsupported');
    assert.equal(extra.headers.Range, 'bytes=0-4095');
    assert.equal(extra.maxContentLength, 65536);
    return {status: 206, headers: {'content-type': 'image/jpeg'}};
  }), true);
  assert.deepEqual(calls, ['head', 'get']);
  assert.equal(await probeImage(OLD, undefined, async () => ({status: 200, headers: {'content-type': 'text/html'}})), false);
});

test('later domain changes repair previously migrated URLs using original provider provenance', async t => {
  const {root, item} = fixture(t);
  await maintainImages(options(root, {probe: async url => url === NEW}));
  const newest = 'https://img.animeunity.test/anime/newest.jpg';
  const result = await maintainImages(options(root, {now: NOW + 86400001,
    fetchInfo: async (_base, id) => ({id, imageurl: newest}), probe: async url => url === newest}));
  assert.equal(result.changed, 1);
  assert.equal(readJson(item(1)).info.poster, newest);
  const state = readJson(path.join(root, 'image-health.json'));
  const regenerated = {...readJson(item(1)), info: {title: 'Test', poster: OLD}};
  assert.equal(applyImageReplacements(regenerated, state.replacements).info.poster, newest);
});

test('confirmed host change queues other records and preserves retries after unavailable provider', async t => {
  const {root, item} = fixture(t, 8);
  for (let id = 1; id <= 8; id++) {
    const record = readJson(item(id));
    const url = `https://img.animeunity.co/anime/${id}.jpg`;
    record.info.poster = url;
    record.artworkInventory = {};
    record.sourceMetadata.info.imageurl = url;
    writeJson(item(id), record);
  }
  const healthy = url => Promise.resolve(url.startsWith('https://images.example.com/'));
  await maintainImages(options(root, {probe: healthy,
    fetchInfo: async (_base, id) => ({id, imageurl: `https://images.example.com/anime/${id}.jpg`})}));
  const state = readJson(path.join(root, 'image-health.json'));
  assert.deepEqual(Object.keys(state.pending), ['6', '7', '8']);
  const result = await maintainImages(options(root, {now: NOW + 1, probe: healthy,
    fetchInfo: async () => {throw new Error('Network unavailable');}}));
  assert.equal(result.changed, 0);
  const deferred = readJson(path.join(root, 'image-health.json'));
  assert(deferred.pending[6].nextCheckAt > NOW + 1);
  assert.equal(readJson(item(6)).info.poster, 'https://img.animeunity.co/anime/6.jpg');
});
