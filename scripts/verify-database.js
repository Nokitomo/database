'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {DATA, file, hash, readJson} = require('./lib');
const {normalizeRelatedLinks} = require('./provider-links');
const {buildArtworkFallbacks} = require('./artwork-fallbacks');

function verifyDatabase(stage = 'all') {
  if (!['raw', 'mapped', 'final', 'all'].includes(stage)) throw new Error(`Invalid stage: ${stage}`);
  const rawIndex = readJson(path.join(DATA, 'raw', 'index.json'));
  const mappedIndex = readJson(path.join(DATA, 'mapped', 'index.json'));
  const manifest = readJson(path.join(DATA, 'final', 'manifest.json'));
  const providerRef = fs.readFileSync(path.join(__dirname, '..', 'vega-providers.ref'), 'utf8').trim();
  if (!rawIndex) throw new Error('raw/index.json missing');
  const ids = rawIndex.expectedIds || [];
  const idSet = new Set(ids);
  if (idSet.size !== ids.length || ids.some(id => !Number.isInteger(id) || id <= 0))
    throw new Error('Invalid archive IDs');
  if (rawIndex.archiveCount !== rawIndex.archiveReportedTotal)
    throw new Error('Archive total mismatch');
  const complete = [];
  let rawCount = 0;
  let mappedCount = 0;
  for (const id of ids) {
    const raw = readJson(file('raw', id));
    if (!raw) continue;
    rawCount++;
    if (raw.id !== id || raw.fingerprint !== hash({info: raw.info, embeddedAnime: raw.embeddedAnime, episodes: raw.episodes}))
      throw new Error(`Raw record ${id} invalid`);
    const mapped = readJson(file('mapped', id));
    if (!mapped || mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== providerRef ||
      mapped.mappingSourceHash !== mappedIndex?.sourceHash) continue;
    mappedCount++;
    if (mapped.id !== id) throw new Error(`Mapped record ${id} invalid`);
    const final = readJson(file('final', id));
    if (!final || final.providerRef !== providerRef || final.rawFingerprint !== raw.fingerprint ||
      final.mappingFingerprint !== hash(mapped) || final.path !== raw.path) continue;
    if (final.id !== id || !final.info?.title || !Array.isArray(final.episodes))
      throw new Error(`Final record ${id} invalid`);
    if (new Set(final.episodes.map(episode => episode.link)).size !== final.episodes.length)
      throw new Error(`Duplicate episode IDs in ${id}`);
    const finalEpisodeIds = new Set(final.episodes.map(episode => String(episode.link)));
    if (raw.episodes.some(episode => !finalEpisodeIds.has(String(episode.id))))
      throw new Error(`Final record ${id} omits source episodes`);
    if (final.linkSchemaVersion === 2 &&
      JSON.stringify(final.info.related || []) !== JSON.stringify(normalizeRelatedLinks(final.info).related || []))
      throw new Error(`Final record ${id} has absolute AnimeUnity related links`);
    if (final.linkSchemaVersion === 2 &&
      JSON.stringify(final.info.extra?.artworkFallbacks) !==
        JSON.stringify(buildArtworkFallbacks(final.info, final.artworkInventory)))
      throw new Error(`Final record ${id} has invalid artwork fallbacks`);
    complete.push(final);
  }
  const checkedIds = rawIndex.checkedIds || [];
  if (checkedIds.length !== rawCount || new Set(checkedIds).size !== checkedIds.length ||
    checkedIds.some(id => !idSet.has(id) || !readJson(file('raw', id))))
    throw new Error('Raw index does not match records');
  if (rawIndex.complete && (rawCount !== ids.length || Object.keys(rawIndex.errors || {}).length > 0))
    throw new Error('Raw index incorrectly marked complete');
  if (stage === 'raw') return {expected: ids.length, raw: rawCount, complete: rawIndex.complete};
  if (mappedIndex && mappedIndex.availableCount !== mappedCount)
    throw new Error('Mapped index count does not match current records');
  if (mappedIndex?.complete && (mappedCount !== ids.length || !rawIndex.complete ||
    Object.keys(mappedIndex.errors || {}).length > 0))
    throw new Error('Mapped index incorrectly marked complete');
  if (stage === 'mapped') return {expected: ids.length, raw: rawCount, mapped: mappedCount,
    complete: Boolean(mappedIndex?.complete)};
  if (manifest) {
    if (!mappedIndex) throw new Error('Mapped index missing');
    if (manifest.providerRef !== providerRef || mappedIndex.providerRef !== providerRef)
      throw new Error('Provider revision mismatch');
    if (manifest.availableCount !== complete.length || manifest.expectedCount !== ids.length)
      throw new Error('Manifest counts do not match current records');
    if (manifest.complete && (complete.length !== ids.length || !rawIndex.complete || !mappedIndex.complete))
      throw new Error('Manifest incorrectly marked complete');
    const catalog = readJson(path.join(DATA, 'final', 'catalog.json'));
    if (!catalog || catalog.records.length !== complete.length || manifest.catalogSha256 !== hash(catalog.records))
      throw new Error('Catalog does not match manifest');
    for (const record of complete) {
      if (manifest.itemHashes?.[record.id] !== hash(record)) throw new Error(`Item hash mismatch: ${record.id}`);
    }
    for (const [key, expected] of Object.entries(manifest.shardHashes || {})) {
      const shard = readJson(path.join(DATA, 'final', 'shards', `${key}.json`));
      if (!shard || hash(shard) !== expected) throw new Error(`Shard hash mismatch: ${key}`);
    }
    if (manifest.qualitySha256) {
      const quality = readJson(path.join(DATA, 'final', 'quality.json'));
      if (!quality || hash(quality) !== manifest.qualitySha256 ||
        quality.coverage?.final !== manifest.availableCount ||
        quality.coverage?.expected !== manifest.expectedCount)
        throw new Error('Quality report does not match manifest');
    }
  }
  return {expected: ids.length, raw: rawCount,
    mapped: mappedCount, final: complete.length,
    complete: Boolean(manifest?.complete)};
}

if (require.main === module) {
  try {
    const index = process.argv.indexOf('--stage');
    console.log(verifyDatabase(index >= 0 ? process.argv[index + 1] : 'all'));
  } catch (error) {console.error(error); process.exitCode = 1;}
}
module.exports = {verifyDatabase};
