'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createResourceCache, resourcePath, validateTarget} = require('../scripts/tmdb-resource');
const {createContext} = require('../scripts/vega');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-resources-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let time = 1000;
  return {root, cache: createResourceCache({root, now: () => time}), advance: n => time += n};
}
test('negative resources share API/web cache and block only matching descendants until expiry', t => {
  const f = fixture(t);
  f.cache.save('/tv/890/season/0', 'missing');
  assert.ok(f.cache.missing('https://api.themoviedb.org/3/tv/890/season/0/images'));
  assert.ok(f.cache.missing('https://www.themoviedb.org/tv/890/season/0/episode/1'));
  assert.equal(f.cache.missing('https://www.themoviedb.org/tv/890/season/1'), null);
  assert.equal(f.cache.missing('https://www.themoviedb.org/movie/890'), null);
  assert.equal(resourcePath('https://api.themoviedb.org/3/tv/890/images'), null);
  f.advance(31 * 86400000);
  assert.equal(f.cache.missing('https://www.themoviedb.org/tv/890/season/0'), null);
});
test('404 validation is durable while 403 remains transient and credential values are not saved', async t => {
  const f = fixture(t);
  const target = {provider: 'tmdb_show', id: '890', scope: 's0'};
  let calls = 0;
  const context = {axios: {get: async () => {calls++; throw {response: {status: 404}};}}};
  const first = await validateTarget(target, context, f.cache, 'private-key');
  assert.equal(first.status, 'missing');
  await validateTarget(target, context, f.cache, 'private-key');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(first).includes('private-key'));
  const denied = await validateTarget({...target, id: '891'}, {axios: {get: async () => {throw {response: {status: 403}};}}}, f.cache, 'private-key');
  assert.equal(denied.status, 'error');
  assert.equal(f.cache.missing('https://www.themoviedb.org/tv/891/season/0'), null);
});
test('valid specials, bearer authentication and malformed success responses', async t => {
  const f = fixture(t);
  let headers;
  const result = await validateTarget({provider: 'tmdb_show', id: '10', scope: 's0'}, {axios: {
    get: async (_url, options) => {headers = options.headers; return {data: {season_number: 0}};},
  }}, f.cache, 'eyJtest.token.signature');
  assert.equal(result.status, 'ok');
  assert.equal(headers.Authorization, 'Bearer eyJtest.token.signature');
  const bad = await validateTarget({provider: 'tmdb_movie', id: '1'}, {axios: {get: async () => ({data: '<blocked>'})}}, f.cache, 'key');
  assert.equal(bad.status, 'error');
});
test('confirmed absence prevents even the first provider HTTP request on subsequent lookups', async t => {
  const f = fixture(t);
  f.cache.save('/tv/1230393', 'missing');
  let calls = 0;
  const context = createContext('.', 'https://example.org', null, {resources: f.cache,
    httpGet: async () => {calls++; return {data: {}};}});
  await assert.rejects(context.axios.get('https://api.themoviedb.org/3/tv/1230393/images'), e => e.response.status === 404);
  await assert.rejects(context.axios.get('https://www.themoviedb.org/tv/1230393'), e => e.response.status === 404);
  assert.equal(calls, 0);
  assert.equal(context.externalStatus.tmdbWeb.transientFailures, 0);
});
test('without an API key a canonical web page can verify a real special season', async t => {
  const f = fixture(t);
  const context = {cheerio: require('cheerio'), axios: {get: async () => ({data:
    '<link rel="canonical" href="https://www.themoviedb.org/tv/44-example/season/0"><h2>Specials</h2>'})}};
  const result = await validateTarget({provider: 'tmdb_show', id: '44', scope: 's0'}, context, f.cache, '');
  assert.equal(result.status, 'ok');
});
