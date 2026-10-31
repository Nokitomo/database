'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createMetadataTasks} = require('../scripts/metadata-tasks');
const {enrichmentDue} = require('../scripts/pipeline');
const {fillTvdbEpisodeGaps} = require('../scripts/vega');
const DAY = 86400000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-tasks-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let time = 1000;
  let errors = 0;
  const create = (options = {}) => createMetadataTasks({root, now: () => time, failures: () => errors, log: () => {}, ...options});
  return {create, advance: duration => time += duration, fail: () => errors++};
}
const task = (source, id) => ({source, kind: 'artwork', input: {id}});
const image = {poster: 'poster', background: 'background', logo: 'logo'};
test('persistent failure doubles retry delay across contexts and success resets it', async t => {
  const f = fixture(t);
  const descriptor = task('tmdb', 123);
  const fail = async () => {f.fail(); return image;};
  let cache = f.create();
  await cache.run(descriptor, fail);
  assert.equal(Object.values(cache.snapshot())[0].retryCount, 1);
  f.advance(31 * 60000);
  cache = f.create();
  await cache.run(descriptor, fail);
  const second = Object.values(cache.snapshot())[0];
  assert.equal(second.retryCount, 2);
  assert.equal(second.nextCheckAt, 1000 + 91 * 60000);
  f.advance(31 * 60000);
  let calls = 0;
  const recover = async () => {calls++; return image;};
  await f.create().run(descriptor, recover);
  assert.equal(calls, 0);
  f.advance(30 * 60000);
  cache = f.create();
  await cache.run(descriptor, recover);
  assert.equal(calls, 1);
  assert.equal(Object.values(cache.snapshot())[0].retryCount, 0);
});
test('confirmed HTTP 404 is missing rather than a transient failure', async t => {
  const f = fixture(t);
  const cache = f.create();
  await cache.run(task('tmdb', 404), async () => {throw {response: {status: 404}};});
  const entry = Object.values(cache.snapshot())[0];
  assert.equal(entry.status, 'missing');
  assert.equal(entry.nextCheckAt, 1000 + 30 * DAY);
});
test('episode failure backoff persists independently and is capped at one week', async t => {
  const f = fixture(t);
  const descriptor = {source: 'tmdb', kind: 'episodes', input: {id: 44}, episodeNumbers: [1]};
  let now = 1000;
  for (let attempt = 1; attempt <= 11; attempt++) {
    const cache = f.create();
    await cache.run(descriptor, async () => {f.fail(); return [episode(1)];});
    const item = Object.values(cache.snapshot())[0];
    const delay = Math.min(7 * DAY, 30 * 60000 * 2 ** (attempt - 1));
    assert.equal(item.nextCheckAt, now + delay);
    assert.equal(item.retryCount, attempt);
    f.advance(delay + 1); now += delay + 1;
  }
});
test('HTTP 403 remains retryable and does not become missing', async t => {
  const f = fixture(t);
  const cache = f.create();
  await assert.rejects(cache.run(task('tmdb', 403), async () => {throw {response: {status: 403}};}));
  const item = Object.values(cache.snapshot())[0];
  assert.equal(item.status, 'error');
  assert.equal(item.nextCheckAt, 1000 + 30 * 60000);
});
test('legacy record-wide retry cannot bypass an unexpired task deadline', () => {
  const now = Date.now();
  const final = {updatedAt: new Date(now - 3600000).toISOString(), info: image, episodes: [],
    sourceStatus: {tmdbWeb: {transientFailures: 1, retryCount: 1}},
    metadataTasks: {x: {source: 'tmdb', status: 'error', nextCheckAt: now + 3600000}}};
  assert.equal(enrichmentDue(final, now), false);
  assert.equal(enrichmentDue(final, now + 3600000), true);
  delete final.metadataTasks;
  assert.equal(enrichmentDue(final, now), true);
});
const episode = number => ({episodeNumber: number, title: {value: `Episode ${number}`, language: 'it'},
  overview: {value: 'Synopsis', language: 'en'}, thumbnail: 'image'});

test('durable reuse is isolated by service and target ID', async t => {
  const f = fixture(t);
  let calls = 0;
  const load = async () => {calls++; return image;};
  await f.create().run(task('tmdb', 1), load);
  await f.create().run(task('tvdb', 1), load);
  await f.create().run(task('tvdb', 2), load);
  assert.deepEqual(await f.create().run(task('tmdb', 1), load), image);
  assert.equal(calls, 3);
});

test('only newly requested episodes are fetched, across contexts', async t => {
  const f = fixture(t);
  const requested = [];
  const load = async numbers => {requested.push(numbers); return {episodes: numbers.map(episode)};};
  const descriptor = {source: 'tmdb', kind: 'episodes', input: {id: 1, season: 1}};
  await f.create().run({...descriptor, episodeNumbers: [1, 2]}, load);
  const result = await f.create().run({...descriptor, episodeNumbers: [2, 3]}, load);
  assert.deepEqual(requested, [[1, 2], [3]]);
  assert.deepEqual(result.episodes.map(row => row.episodeNumber), [2, 3]);
});

test('missing metadata has a longer retry interval than transient failure', async t => {
  const f = fixture(t);
  let calls = 0;
  const missing = async () => {calls++; return null;};
  const descriptor = {source: 'tmdb', kind: 'season-poster', input: {id: 1, season: 0}};
  await f.create().run(descriptor, missing);
  f.advance(DAY);
  await f.create().run(descriptor, missing);
  assert.equal(calls, 1);
  f.advance(30 * DAY);
  await f.create().run(descriptor, missing);
  assert.equal(calls, 2);
});

test('partial failed refresh retains valid fields and retries after backoff', async t => {
  const f = fixture(t);
  const descriptor = task('tvdb', 1);
  await f.create().run(descriptor, async () => image);
  f.advance(91 * DAY);
  const cache = f.create();
  const result = await cache.run(descriptor, async () => {
    f.fail(); return {poster: undefined, logo: 'new-logo'};
  });
  assert.deepEqual(result, {...image, logo: 'new-logo'});
  assert.equal(Object.values(cache.snapshot())[0].status, 'error');
  let calls = 0;
  const load = async () => {calls++; return image;};
  await f.create().run(descriptor, load);
  assert.equal(calls, 0);
  f.advance(31 * 60000);
  await f.create().run(descriptor, load);
  assert.equal(calls, 1);
});

test('concurrent episode selections merge without losing earlier results', async t => {
  const f = fixture(t);
  const cache = f.create();
  const descriptor = {source: 'tvdb', kind: 'episodes', input: {id: 1, season: 1}};
  const load = async numbers => numbers.map(episode);
  await Promise.all([
    cache.run({...descriptor, episodeNumbers: [1]}, load),
    cache.run({...descriptor, episodeNumbers: [2]}, load),
  ]);
  const result = await f.create().run({...descriptor, episodeNumbers: [1, 2]}, () => {
    throw new Error('Unexpected refetch');
  });
  assert.deepEqual(result.map(row => row.episodeNumber), [1, 2]);
});

test('a missing individual field schedules enrichment even when the selected image exists', async t => {
  const f = fixture(t);
  const cache = f.create();
  await cache.run(task('tmdb', 1), async () => ({poster: 'poster'}));
  const item = Object.values(cache.snapshot())[0];
  assert.equal(item.status, 'missing');
  assert.equal(item.nextCheckAt, 1000 + 30 * DAY);
  const final = {updatedAt: new Date(1000).toISOString(), info: image, episodes: [], metadataTasks: cache.snapshot()};
  assert.equal(enrichmentDue(final, item.nextCheckAt - 1), false);
  assert.equal(enrichmentDue(final, item.nextCheckAt), true);
});

test('TVDB fills individual TMDB gaps before lower priority fallback values', async () => {
  const row = {link: '1', title: 'TMDB title', thumbnail: 'TMDB image', synopsis: 'AniZip synopsis',
    metadataSources: {tmdb: {title: 'TMDB title', thumbnail: 'TMDB image'}},
    externalMappings: [{provider: 'tvdb_show', id: '10', seasonNumber: 1, episodeNumbers: [2]}]};
  let calls = 0;
  const resolve = async () => {calls++; return [{episodeNumber: 2, title: 'TVDB title',
    synopsis: 'TVDB synopsis', thumbnail: 'TVDB image', titleLanguage: 'ita', synopsisLanguage: 'eng'}];};
  await fillTvdbEpisodeGaps('.', {}, new Map([['1', row]]), {info: {}}, resolve);
  assert.equal(calls, 1);
  assert.equal(row.title, 'TMDB title');
  assert.equal(row.thumbnail, 'TMDB image');
  assert.equal(row.synopsis, 'TVDB synopsis');
  assert.equal(row.metadataSources.tvdb.title, 'TVDB title');
  assert.equal(row.metadataSources.tvdb.synopsisLanguage, 'eng');
});

test('complete TMDB episodes do not trigger TVDB episode requests', async () => {
  const primary = {title: 'Title', synopsis: 'Synopsis', thumbnail: 'Image'};
  const row = {...primary, metadataSources: {tmdb: primary},
    externalMappings: [{provider: 'tvdb_show', id: '10', seasonNumber: 1, episodeNumbers: [2]}]};
  let calls = 0;
  await fillTvdbEpisodeGaps('.', {}, new Map([['1', row]]), {info: {}}, async () => {calls++; return [];});
  assert.equal(calls, 0);
  assert.deepEqual(row.metadataSources, {tmdb: primary});
});

test('resuming another episode group retains earlier missing field deadlines', async t => {
  const f = fixture(t);
  const descriptor = {source: 'tmdb', kind: 'episodes', input: {id: 1, season: 1}};
  const first = f.create();
  await first.run({...descriptor, episodeNumbers: [1]}, async () => [{episodeNumber: 1, title: 'Only title'}]);
  const second = f.create({initialTasks: first.snapshot()});
  await second.run({...descriptor, episodeNumbers: [2]}, async () => [episode(2)]);
  const entry = Object.values(second.snapshot())[0];
  assert.equal(entry.status, 'missing');
  assert.equal(entry.nextCheckAt, 1000 + 30 * DAY);
  assert.deepEqual(entry.episodeNumbers, [1, 2]);
});
