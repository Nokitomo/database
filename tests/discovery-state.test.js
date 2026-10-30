'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {initialDiscoveryState, reconcileDiscovery} = require('../scripts/discovery-state');
const {archiveItems, verifyAnimeUnavailable} = require('../scripts/source');

const item = (id, slug = `title-${id}`) => ({id, slug, path: `/anime/${id}-${slug}`});
const archive = (...items) => ({items: new Map(items.map(value => [value.id, value])), total: items.length});

test('a missing sitemap entry stays active using the last complete archive snapshot', async () => {
  const state = {schemaVersion: 1, archive: {checkedAt: '2026-10-29T11:00:00Z', total: 2,
    items: [item(7874), item(7875)]}, known: {7874: item(7874), 7875: item(7875)}, inactive: {}};
  const result = await reconcileDiscovery({sitemap: new Map(), archive: null, state,
    verifyUnavailable: () => {throw new Error('No removal checks without a fresh archive');}});
  assert.deepEqual([...result.merged.keys()], [7874, 7875]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.state.archive.total, 2);
});

test('first deployment restores known raw records missing from the current sitemap and index', () => {
  const state = initialDiscoveryState({expectedIds: [1], archiveOnly: []}, [item(1), item(7874), item(7875)]);
  assert.deepEqual(Object.keys(state.known), ['1', '7874', '7875']);
  assert.equal(state.known[7874].path, '/anime/7874-title-7874');
});

test('a complete archive omission retains a title when its page is still available', async () => {
  const state = initialDiscoveryState({expectedIds: [1, 2]}, [item(1), item(2)]);
  const checked = [];
  const result = await reconcileDiscovery({sitemap: new Map([[1, item(1)]]), archive: archive(item(1)),
    state, verifyUnavailable: async id => {checked.push(id); return false;}});
  assert.deepEqual(checked, [2]);
  assert.equal(result.merged.has(2), true);
  assert.deepEqual(result.state.inactive, {});
});

test('confirmed disappearance excludes a title but preserves its saved identity for reappearance', async () => {
  const state = initialDiscoveryState({expectedIds: [1, 2]}, [item(1), item(2)]);
  const first = await reconcileDiscovery({sitemap: new Map([[1, item(1)]]), archive: archive(item(1)),
    state, verifyUnavailable: async () => true});
  assert.deepEqual(first.removed, [2]);
  assert.equal(first.merged.has(2), false);
  assert.equal(first.state.known[2].path, item(2).path);
  const second = await reconcileDiscovery({sitemap: new Map(), archive: null, state: first.state,
    verifyUnavailable: () => {throw new Error('No fresh scan');}});
  assert.equal(second.merged.has(2), false);
  const third = await reconcileDiscovery({sitemap: new Map([[2, item(2)]]), archive: null,
    state: second.state, verifyUnavailable: () => {throw new Error('No fresh scan');}});
  assert.equal(third.merged.has(2), true);
  assert.equal(third.reactivated.has(2), true);
  assert.equal(third.state.inactive[2], undefined);
  assert.ok(third.state.reactivationPending[2]);
  const fourth = await reconcileDiscovery({sitemap: new Map([[2, item(2)]]), archive: null,
    state: third.state, verifyUnavailable: () => {throw new Error('No fresh scan');}});
  assert.ok(fourth.state.reactivationPending[2]);
});

test('a removal requires both the info API and anime page to confirm absence', async () => {
  const absent = async (_method, url) => {
    if (url.includes('/info_api/')) throw {status: 404};
    throw {status: 410};
  };
  assert.equal(await verifyAnimeUnavailable(2, item(2), 'https://www.animeunity.co', absent), true);
  const pageAlive = async (_method, url) => {
    if (url.includes('/info_api/')) throw {status: 404};
    return {status: 200};
  };
  assert.equal(await verifyAnimeUnavailable(2, item(2), 'https://www.animeunity.co', pageAlive), false);
  const timeout = async (_method, url) => {
    if (url.includes('/info_api/')) throw {status: 404};
    throw {code: 'ETIMEDOUT'};
  };
  assert.equal(await verifyAnimeUnavailable(2, item(2), 'https://www.animeunity.co', timeout), false);
});

test('an archive scan must have complete, stable pagination before it can confirm removals', async () => {
  const fetch = async (_method, url, payload) => {
    if (url.endsWith('/')) return {data: '<html></html>', headers: {}};
    const offset = payload.offset;
    const records = Array.from({length: offset === 0 ? 30 : 1}, (_, index) =>
      ({id: offset + index + 1, slug: `anime-${offset + index + 1}`}));
    return {data: {tot: offset === 0 ? 31 : 32, records}};
  };
  await assert.rejects(archiveItems('https://www.animeunity.co', fetch),
    /Archive total changed during pagination/);
});
