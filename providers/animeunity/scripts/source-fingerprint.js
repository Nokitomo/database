'use strict';
const {DATA, hash, file, listIds, readJson, writeJson} = require('./lib');
const marker = require('node:path').join(DATA, 'source-fingerprint-migration.json');
const {canonical, migrateFinalMapping} = require('./incremental');
// Ignore only provider counters, retaining all other fields and array order.
function withoutCounters(value) {
  if (Array.isArray(value)) return value.map(withoutCounters);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['visite', 'favorites', 'members'].includes(key))
    .map(([key, child]) => [key, withoutCounters(child)]));
  return value;
}
function sourceContent(raw) { return {info: raw.info, embeddedAnime: raw.embeddedAnime, episodes: raw.episodes}; }
function sourceFingerprint(raw) { return hash(canonical(withoutCounters(sourceContent(raw)))); }
function validFingerprint(raw) {
  return raw.fingerprint === (raw.fingerprintVersion === 2 ? sourceFingerprint(raw) : hash(sourceContent(raw)));
}
function finalSource(final) {
  if (!final?.sourceMetadata || !Array.isArray(final.sourceEpisodes)) return null;
  return {info: final.sourceMetadata.info, embeddedAnime: final.sourceMetadata.embedded, episodes: final.sourceEpisodes};
}
function migrateRecords(raw, mapped, final, progress, previous = raw) {
  const fingerprint = sourceFingerprint(raw);
  const oldFinalSource = finalSource(final);
  const sameFinal = oldFinalSource && sourceFingerprint(oldFinalSource) === fingerprint;
  const samePrevious = sourceFingerprint(previous) === fingerprint;
  const matchesOld = value => value && ((samePrevious && value.rawFingerprint === previous.fingerprint) ||
    (sameFinal && value.rawFingerprint === final.rawFingerprint));
  const nextMapped = matchesOld(mapped) ? {...mapped, rawFingerprint: fingerprint} : mapped;
  let nextFinal = migrateFinalMapping(final, mapped, nextMapped);
  if (sameFinal) nextFinal = {...nextFinal, rawFingerprint: fingerprint};
  const nextProgress = matchesOld(progress) ? {...progress, rawFingerprint: fingerprint} : progress;
  return {raw: {...raw, fingerprint, fingerprintVersion: 2,
    changedAt: samePrevious ? previous.changedAt : raw.changedAt}, mapped: nextMapped, final: nextFinal, progress: nextProgress};
}
function migrateStoredSources() {
  let count = 0;
  for (const id of listIds('raw')) {
    const raw = readJson(file('raw', id));
    if (raw.fingerprintVersion === 2) continue;
    if (!validFingerprint(raw)) throw new Error('Cannot migrate invalid raw record ' + id);
    const paths = {raw: file('raw', id), mapped: file('mapped', id), final: file('final', id),
      progress: require('node:path').join(require('./lib').DATA, 'final', 'progress', id + '.json')};
    writeJson(marker, {pending: true});
    const before = {raw, mapped: readJson(paths.mapped), final: readJson(paths.final), progress: readJson(paths.progress)};
    const after = migrateRecords(raw, before.mapped, before.final, before.progress);
    // Write dependents first: an interrupted migration is safely repeatable.
    for (const key of ['mapped', 'final', 'progress', 'raw'])
      if (after[key] && JSON.stringify(after[key]) !== JSON.stringify(before[key])) writeJson(paths[key], after[key]);
    count++;
  }
  if (count) console.log('SOURCE_FINGERPRINT_MIGRATION ' + count);
  return count || (readJson(marker)?.pending ? 1 : 0);
}
function finishMigration() { require('node:fs').rmSync(marker, {force: true}); }
module.exports = {finishMigration, sourceFingerprint, validFingerprint, migrateRecords, migrateStoredSources};
