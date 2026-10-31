'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {applyMappingPolicy, addTypedFallback, needsMappingRepair, installMappingOverride} = require('../scripts/mapping-policy');
const {mappingFingerprint} = require('../scripts/incremental');
const {mappingDue} = require('../scripts/pipeline');
const t = (provider, id, scope) => ({provider, id: String(id), scope, ranges: {'1': '1'}});
const resolution = targets => ({targets, metadataTargets: targets, ids: {tvdbShowIds: [389459]}});
test('AniZip generic ID cannot replace a direct film ID or copy a TVDB season', async () => {
  const film = t('tmdb_movie', 75629);
  const input = resolution([film]);
  assert.equal(addTypedFallback(input, [film], {tmdbId: 890, mediaType: 'movie'}).resolution, input);
  const invented = t('tmdb_show', 22, 's3');
  const typed = addTypedFallback(resolution([invented]), [], {tmdbId: 22, mediaType: 'series'});
  const safe = await applyMappingPolicy(typed.resolution, typed.directTargets, async () => ({status: 'ok'}));
  assert.equal(safe.targets.length, 1);
  assert.equal(safe.targets[0].scope, undefined);
  assert.deepEqual(safe.targets[0].ranges, {});
  assert.equal(addTypedFallback(input, [], {tmdbId: 22}).resolution, input);
});
test('ONA movie retains typed movie and TVDB special without inventing a TMDB series', async () => {
  const movie = t('tmdb_movie', 1179822), tvdb = t('tvdb_show', 389459, 's0');
  const invented = t('tmdb_show', 1179822, 's0');
  const original = resolution([movie, tvdb, invented]);
  const requested = [];
  const result = await applyMappingPolicy(original, [movie, tvdb], async target => {requested.push(target); return {status: 'ok'};});
  assert.deepEqual(result.targets, [movie, tvdb]);
  assert.equal(result.metadataMediaType, 'movie');
  assert.deepEqual(result.ids.tmdbShowIds, []);
  assert.deepEqual(result.ids.tvdbShowIds, [389459]);
  assert.equal(result.mappingPolicy.rejected[0].reason, 'unverified-inferred-tmdb-target');
  assert.equal(requested.length, 1);
  assert.equal(original.targets.length, 3);
});
test('unscoped invented Monsters series is removed; movie survives', async () => {
  const movie = t('tmdb_movie', 1230393), invented = t('tmdb_show', 1230393);
  const result = await applyMappingPolicy(resolution([movie, invented]), [movie], async () => ({status: 'ok'}));
  assert.deepEqual(result.targets, [movie]);
});
test('confirmed absent Evangelion specials are excluded, valid specials and network failures are not', async () => {
  const movie = t('tmdb_movie', 75629), special = t('tmdb_show', 890, 's0');
  const original = resolution([movie, special]);
  const result = await applyMappingPolicy(original, original.targets, async target =>
    ({status: target === special ? 'missing' : 'ok', nextCheckAt: 12345}));
  assert.deepEqual(result.targets, [movie]);
  assert.equal(result.mappingPolicy.nextCheckAt, 12345);
  for (const status of ['ok', 'error']) {
    const preserved = await applyMappingPolicy(original, original.targets, async () => ({status}));
    assert.deepEqual(preserved.targets, original.targets);
  }
});
test('migration is selective and policy bookkeeping alone does not invalidate final metadata', () => {
  const raw = {fingerprint: 'f', info: {type: 'TV'}};
  const mapped = {metadataTargets: [t('tmdb_show', 100, 's1')], rawFingerprint: 'f', providerRef: 'r', mappingSourceHash: 'h'};
  assert.equal(mappingDue(raw, mapped, 'r', 'h'), false);
  assert.equal(mappingDue(raw, mapped, 'r', 'h', false, null,
    {metadataTasks: {x: {source: 'tmdb', status: 'error'}}}), true);
  const suspect = {...mapped, metadataTargets: [t('tmdb_show', 890, 's0')]};
  assert.equal(mappingDue(raw, suspect, 'r', 'h'), true);
  assert.equal(needsMappingRepair({...suspect, mappingPolicy: {version: 1}}, raw), false);
  assert.equal(mappingFingerprint(mapped), mappingFingerprint({...mapped, mappingPolicy: {version: 1, checks: []}}));
  assert.notEqual(mappingFingerprint(mapped), mappingFingerprint({...mapped, metadataMediaType: 'movie'}));
});
test('resolver override is scoped to this anime and never changes other consumers', async () => {
  let calls = 0;
  const resolver = {resolveAnimeMappings: async () => {calls++; return 'original';}};
  installMappingOverride(resolver); installMappingOverride(resolver);
  const providerContext = {databaseMappingOverride: {anilistId: 1, resolution: 'safe'}};
  assert.equal(await resolver.resolveAnimeMappings({providerContext, anilistId: 1, isMovie: false}), 'safe');
  assert.equal(await resolver.resolveAnimeMappings({providerContext, anilistId: 2}), 'original');
  assert.equal(await resolver.resolveAnimeMappings({providerContext: {}, anilistId: 1}), 'original');
  assert.equal(calls, 2);
});
