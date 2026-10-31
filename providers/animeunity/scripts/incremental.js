'use strict';

const {hash} = require('./lib');
const ENRICHMENT_SCHEMA_VERSION = 2;

function refreshPlan(final, raw, mapped, now = Date.now()) {
  const sameInputs = !!final && final.rawFingerprint === raw.fingerprint &&
    matchesMapping(final, mapped) && final.path === raw.path;
  const recent = sameInputs && now - Date.parse(final.updatedAt || 0) < 90 * 86400000;
  const episodeTasks = Object.entries(final?.metadataTasks || {}).filter(([, task]) =>
    task.kind === 'episodes' || task.kind === 'season-layout');
  const episodeTasksDue = episodeTasks.some(([, task]) =>
    !Number.isFinite(task.nextCheckAt) || task.nextCheckAt <= now);
  const missingEpisodes = (final?.episodes || []).some(episode =>
    !episode.title || !episode.synopsis || !episode.thumbnail);
  const missingDue = missingEpisodes && now - Date.parse(final?.updatedAt || 0) >= 30 * 86400000;
  const reuseEpisodes = recent && final.enrichmentSchemaVersion === ENRICHMENT_SCHEMA_VERSION &&
    !episodeTasksDue && !missingDue;
  const metadataDue = Object.values(final?.metadataTasks || {}).some(task =>
    Number.isFinite(task.nextCheckAt) && task.nextCheckAt <= now);
  return {reuseInfo: recent && !metadataDue && !final?.sourceStatus?.tmdbWeb?.transientFailures, reuseEpisodes,
    retainedTasks: reuseEpisodes ? Object.fromEntries(episodeTasks) : {},
    reason: !sameInputs ? 'source-or-mapping-changed' :
      final.enrichmentSchemaVersion !== ENRICHMENT_SCHEMA_VERSION ? 'schema-backfill' :
      reuseEpisodes ? 'artwork-refresh' : 'episode-refresh'};
}

// Control timestamps and upstream snapshot identifiers are not metadata.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value)
    .filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function setValues(values = []) {
  return [...new Map(values.map(value => [JSON.stringify(canonical(value)), canonical(value)])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function mappingContent(mapped = {}) {
  return canonical({
    id: mapped.id, sourceIds: mapped.sourceIds || {}, imdbId: mapped.imdbId || null,
    ids: Object.fromEntries(Object.entries(mapped.ids || {}).map(([key, values]) =>
      [key, Array.isArray(values) ? setValues(values) : values])),
    targets: setValues(mapped.mappings?.targets),
    // The provider can choose the first metadata target: retain this meaningful order.
    metadataTargets: mapped.metadataTargets || [],
    ...(mapped.metadataMediaType ? {metadataMediaType: mapped.metadataMediaType} : {}),
  });
}
function mappingFingerprint(mapped) { return hash(mappingContent(mapped)); }
function matchesMapping(final, mapped) {
  return !!final && !!mapped && final.mappingFingerprint ===
    (final.mappingFingerprintVersion === 2 ? mappingFingerprint(mapped) : hash(mapped));
}
function migrateFinalMapping(final, previous, next) {
  if (!final || !previous || !matchesMapping(final, previous) ||
      mappingFingerprint(previous) !== mappingFingerprint(next)) return final;
  return {...final, mappingFingerprintVersion: 2, mappingFingerprint: mappingFingerprint(next)};
}
function finalIsCurrent(final, raw, mapped, revision) {
  return !!raw && !!mapped && !!final && mapped.rawFingerprint === raw.fingerprint &&
    mapped.providerRef === revision && final.providerRef === revision &&
    final.rawFingerprint === raw.fingerprint && matchesMapping(final, mapped) && final.path === raw.path;
}
function publishable(final, id) {
  return !!final && final.id === id && !!final.info?.title && Array.isArray(final.episodes);
}

// Hash the consumer data, not refresh bookkeeping. Changing a check time alone
// must not make every client download a record again.
function consumerContent(record) {
  const info = structuredClone(record.info);
  if (info?.extra?.mappings) delete info.extra.mappings.generatedOn;
  return canonical({id: record.id, path: record.path, linkSchemaVersion: record.linkSchemaVersion,
    info, episodes: record.episodes, sourceIds: record.sourceIds,
    seasons: record.seasons, artworkInventory: record.artworkInventory,
    artworkLibrary: record.artworkLibrary});
}

module.exports = {canonical, setValues, mappingContent, mappingFingerprint, matchesMapping,
  migrateFinalMapping, finalIsCurrent, publishable, consumerContent, refreshPlan, ENRICHMENT_SCHEMA_VERSION};
