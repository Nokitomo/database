'use strict';

const {hash} = require('./lib');
const ENRICHMENT_SCHEMA_VERSION = 2;

function refreshPlan(final, raw, mapped, now = Date.now()) {
  const sameSource = !!final && final.rawFingerprint === raw.fingerprint && final.path === raw.path;
  const sameInputs = sameSource && matchesMapping(final, mapped);
  const components = componentDependencies(mapped);
  const agrees = component => matchesMapping(final, mapped) ||
    final?.componentDependencies?.[component] === components[component];
  const recent = sameSource && now - Date.parse(final.updatedAt || 0) < 90 * 86400000;
  const episodeTasks = Object.entries(final?.metadataTasks || {}).filter(([, task]) =>
    task.kind === 'episodes' || task.kind === 'season-layout');
  const episodeTasksDue = episodeTasks.some(([, task]) =>
    !Number.isFinite(task.nextCheckAt) || task.nextCheckAt <= now);
  const missingEpisodes = (final?.episodes || []).some(episode =>
    !episode.title || !episode.synopsis || !episode.thumbnail);
  const missingDue = missingEpisodes && now - Date.parse(final?.updatedAt || 0) >= 30 * 86400000;
  const reuseEpisodes = recent && agrees('episodes') && final.enrichmentSchemaVersion === ENRICHMENT_SCHEMA_VERSION &&
    !episodeTasksDue && !missingDue;
  const metadataDue = Object.values(final?.metadataTasks || {}).some(task =>
    Number.isFinite(task.nextCheckAt) && task.nextCheckAt <= now);
  return {reuseInfo: recent && agrees('info') && !metadataDue && !final?.sourceStatus?.tmdbWeb?.transientFailures, reuseEpisodes,
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

// Empty-range related IDs can change without changing any playback mapping.
// Keep all nonempty ranges: these are consumed by the episode resolver, even
// when their target is not the primary artwork target.
function componentDependencies(mapped = {}) {
  const content = mappingContent(mapped);
  const mediaType = mapped.metadataMediaType || (/movie/i.test(mapped.sourceMediaType || '') ? 'movie' : mapped.sourceMediaType || null);
  const direct = mapped.metadataTargets;
  if (!Array.isArray(direct)) return {info: mappingFingerprint(mapped), episodes: mappingFingerprint(mapped), artwork: mappingFingerprint(mapped), episodeIdentity: mappingFingerprint(mapped)};
  const identity = {sourceIds: content.sourceIds, imdbId: content.imdbId,
    metadataMediaType: mediaType, metadataTargets: direct};
  const ranges = content.targets.filter(t => Object.keys(t.ranges || {}).length);
  const scopes = content.targets.filter(t => direct.some(d => d.provider === t.provider && d.id === t.id))
    .map(({provider, id, scope}) => ({provider, id, scope}));
  const artworkServices = Object.fromEntries(['tmdb', 'tvdb', 'cinemeta', 'anizip', 'anilist'].map(source =>
    [source, hash(canonical({sourceIds: content.sourceIds, metadataMediaType: mediaType,
      targets: direct.filter(t => t.provider.startsWith(source + '_')),
      scopes: scopes.filter(t => t.provider.startsWith(source + '_')),
      ...(source === 'cinemeta' ? {imdbId: content.imdbId} : {})}))]));
  const episodeIdentity = hash(canonical({...identity, metadataTargets: direct.map(({ranges, ...target}) => target)}));
  return {info: hash(canonical({identity, ranges})), episodes: hash(canonical({identity, ranges})), episodeIdentity,
    artwork: hash(canonical({identity, scopes})), artworkServices};
}
function matchesMapping(final, mapped) {
  return !!final && !!mapped && final.mappingFingerprint ===
    (final.mappingFingerprintVersion === 2 ? mappingFingerprint(mapped) : hash(mapped));
}
function migrateFinalMapping(final, previous, next) {
  if (!final || !previous || !matchesMapping(final, previous)) return final;
  const before = componentDependencies(previous), after = componentDependencies(next);
  // Always retain the dependencies that actually produced this snapshot.
  const migrated = {...final, componentDependencies: before};
  if (mappingFingerprint(previous) === mappingFingerprint(next))
    return {...migrated, mappingFingerprintVersion: 2, mappingFingerprint: mappingFingerprint(next)};
  if (JSON.stringify(before) !== JSON.stringify(after)) return migrated;
  const info = structuredClone(final.info);
  if (info?.extra) {info.extra.ids = next.ids; info.extra.mappings = next.mappings;}
  return {...migrated, info, mappings: next.mappings, sourceIds: next.sourceIds,
    mappingPolicy: next.mappingPolicy, mappingFingerprintVersion: 2,
    mappingFingerprint: mappingFingerprint(next)};
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
  componentDependencies, migrateFinalMapping, finalIsCurrent, publishable, consumerContent, refreshPlan, ENRICHMENT_SCHEMA_VERSION};
