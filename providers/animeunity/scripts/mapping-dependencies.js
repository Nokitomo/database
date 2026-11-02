'use strict';

const {hash} = require('./lib');
const {canonical} = require('./incremental');

// Use the provider's own forward/reverse lookup. Hashing only direct entries
// would miss newly added reverse mappings, scoped records and removed edges.
function dependencyFingerprint(index, findRecords, raw) {
  const anilistId = Number(raw.info?.anilist_id || raw.embeddedAnime?.anilist_id) || undefined;
  const malId = Number(raw.info?.mal_id || raw.embeddedAnime?.mal_id) || undefined;
  const direct = [anilistId && `anilist:${anilistId}`, malId && `mal:${malId}`]
    .filter(Boolean).map(key => [key, index.records.get(key) || null]);
  return hash(canonical({version: 1, schema: index.schemaVersion, anilistId, malId,
    isMovie: /movie/i.test(raw.info?.type || raw.embeddedAnime?.type || ''), direct,
    records: findRecords(index, anilistId, malId)}));
}

function canAcknowledgeIndex(mapped, raw, revision, sourceHash, dependency, now = Date.now()) {
  if (!mapped || mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== revision ||
      (Number.isFinite(mapped.mappingPolicy?.nextCheckAt) && mapped.mappingPolicy.nextCheckAt <= now)) return false;
  // Bootstrap only from the exact index that produced the stored mapping.
  return mapped.mappingSourceHash === sourceHash ||
    mapped.mappingDependencyVersion === 1 && mapped.mappingDependencyFingerprint === dependency;
}

module.exports = {dependencyFingerprint, canAcknowledgeIndex};
