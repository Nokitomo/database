'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {hash} = require('../scripts/lib');
const {sourceFingerprint, validFingerprint, migrateRecords} = require('../scripts/source-fingerprint');
const {mappingFingerprint, matchesMapping} = require('../scripts/incremental');
function fixture() {
  const raw = {id: 1, path: '/anime/1-test', info: {title: 'Test', score: 7},
    embeddedAnime: {visite: 1, favorites: 2, members: 3},
    episodes: [{id: 10, number: '1', visite: 10, hidden: 0}], changedAt: 'old'};
  raw.fingerprint = hash({info: raw.info, embeddedAnime: raw.embeddedAnime, episodes: raw.episodes});
  const mapped = {id: 1, rawFingerprint: raw.fingerprint, ids: {tmdbMovieIds: [100]}};
  const final = {rawFingerprint: raw.fingerprint, mappingFingerprint: hash(mapped),
    sourceMetadata: {info: structuredClone(raw.info), embedded: structuredClone(raw.embeddedAnime)},
    sourceEpisodes: structuredClone(raw.episodes), updatedAt: 'old', enrichmentSchemaVersion: 1};
  return {raw, mapped, final};
}
test('counters do not change semantic source fingerprint, including episode visits', () => {
  const {raw} = fixture(), next = structuredClone(raw);
  next.embeddedAnime = {visite: 300, favorites: 100, members: 90}; next.episodes[0].visite++;
  assert.equal(sourceFingerprint(raw), sourceFingerprint(next));
  assert.equal(next.embeddedAnime.visite, 300);
});
test('metadata, score, episode availability, IDs and fractional episode numbers remain meaningful', () => {
  for (const mutate of [r => r.info.title = 'Other', r => r.info.score++, r => r.episodes[0].hidden = 1,
    r => r.episodes[0].number = '0', r => r.episodes[0].number = '3.5', r => r.episodes[0].id++,
    r => r.episodes.push({id: 11, number: '2'}), r => r.embeddedAnime.anilist_id = 42]) {
    const {raw} = fixture(), next = structuredClone(raw); mutate(next);
    assert.notEqual(sourceFingerprint(raw), sourceFingerprint(next));
  }
});
test('legacy records migrate together without enrichment or resetting timestamps/schema', () => {
  const {raw, mapped, final} = fixture();
  const progress = {rawFingerprint: raw.fingerprint, nextGroup: 4};
  const next = migrateRecords(raw, mapped, final, progress);
  assert.equal(next.raw.fingerprintVersion, 2); assert.ok(validFingerprint(next.raw));
  assert.equal(next.mapped.rawFingerprint, next.raw.fingerprint);
  assert.equal(next.final.rawFingerprint, next.raw.fingerprint);
  assert.ok(matchesMapping(next.final, next.mapped));
  assert.equal(next.final.updatedAt, 'old'); assert.equal(next.final.enrichmentSchemaVersion, 1);
  assert.equal(next.raw.changedAt, 'old'); assert.equal(next.progress.nextGroup, 4);
  assert.equal(next.progress.rawFingerprint, next.raw.fingerprint);
  assert.deepEqual(migrateRecords(next.raw, next.mapped, next.final, next.progress), next);
});
test('already stale counter-only sources are reconciled using saved final source', () => {
  const {raw, mapped, final} = fixture(); raw.embeddedAnime.visite++;
  raw.fingerprint = hash({info: raw.info, embeddedAnime: raw.embeddedAnime, episodes: raw.episodes});
  const next = migrateRecords(raw, mapped, final, null);
  assert.equal(next.mapped.rawFingerprint, next.raw.fingerprint);
  assert.equal(next.final.rawFingerprint, next.raw.fingerprint);
  assert.ok(matchesMapping(next.final, next.mapped));
});
test('real stale source and unrelated mapping changes remain stale', () => {
  const {raw, mapped, final} = fixture(); raw.episodes.push({id: 11, number: '2'});
  raw.fingerprint = hash({info: raw.info, embeddedAnime: raw.embeddedAnime, episodes: raw.episodes});
  const next = migrateRecords(raw, mapped, final, null);
  assert.notEqual(next.mapped.rawFingerprint, next.raw.fingerprint);
  assert.notEqual(next.final.rawFingerprint, next.raw.fingerprint);
  const another = fixture(); another.mapped.ids.tmdbMovieIds = [200];
  const changed = migrateRecords(another.raw, another.mapped, another.final, null);
  assert.ok(!matchesMapping(changed.final, changed.mapped));
});
test('missing source snapshots are not assumed equivalent and corrupt fingerprints are rejected', () => {
  const {raw, mapped, final} = fixture(); delete final.sourceMetadata;
  const next = migrateRecords(raw, mapped, final, null);
  assert.notEqual(next.final.rawFingerprint, next.raw.fingerprint);
  assert.ok(validFingerprint(raw)); assert.ok(!validFingerprint({...raw, fingerprint: 'wrong'}));
  assert.ok(!validFingerprint({...next.raw, fingerprint: 'wrong'}));
});
test('interrupted migration can repeat after dependencies have already been written', () => {
  const {raw, mapped, final} = fixture(), next = migrateRecords(raw, mapped, final, null);
  const resumed = migrateRecords(raw, next.mapped, next.final, null);
  assert.deepEqual(resumed, next);
});

test('CLI migrates saved sources before running any pipeline stage', () => {
  const source = require('node:fs').readFileSync(require.resolve('../scripts/pipeline'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('migrateStoredSources()') >= 0);
  assert.ok(main.indexOf('migrateStoredSources()') < main.indexOf('await runRaw(options)'));
});
