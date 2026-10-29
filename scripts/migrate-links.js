'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {DATA, hash, readJson, writeJson} = require('./lib');
const {normalizeRelatedLinks} = require('./provider-links');
const {buildArtworkFallbacks} = require('./artwork-fallbacks');
const {rebuildFinalArtifacts} = require('./pipeline');
const {matchesMapping} = require('./incremental');

function migrateLinks({apply = false, dataRoot = DATA, providerRefPath = path.join(DATA, '..', 'vega-providers.ref')} = {}) {
  const recordFile = (stage, id) => path.join(dataRoot, stage, 'items', `${id}.json`);
  const source = readJson(path.join(dataRoot, 'raw', 'index.json'));
  const mappingIndex = readJson(path.join(dataRoot, 'mapped', 'index.json'));
  const manifest = readJson(path.join(dataRoot, 'final', 'manifest.json'));
  const revision = fs.readFileSync(providerRefPath, 'utf8').trim();
  if (!source || !mappingIndex || !manifest) throw new Error('Database indexes are missing');
  if (mappingIndex.providerRef !== revision || manifest.providerRef !== revision)
    throw new Error('Provider revision mismatch; refresh the pipeline first');
  const changes = [];
  for (const id of source.expectedIds) {
    const raw = readJson(recordFile('raw', id));
    const mapped = readJson(recordFile('mapped', id));
    const final = readJson(recordFile('final', id));
    if (!raw || !mapped || !final || mapped.providerRef !== revision ||
      mapped.mappingSourceHash !== mappingIndex.sourceHash || mapped.rawFingerprint !== raw.fingerprint ||
      final.providerRef !== revision || final.rawFingerprint !== raw.fingerprint ||
      !matchesMapping(final, mapped) || final.path !== raw.path) continue;
    const normalized = normalizeRelatedLinks(final.info);
    const info = {...normalized, extra: {...normalized.extra,
      artworkFallbacks: buildArtworkFallbacks(normalized, final.artworkInventory)}};
    if (final.linkSchemaVersion === 2 && JSON.stringify(info.related) === JSON.stringify(final.info.related) &&
      JSON.stringify(info.extra.artworkFallbacks) === JSON.stringify(final.info.extra?.artworkFallbacks)) continue;
    changes.push(id);
    if (apply) writeJson(recordFile('final', id), {...final, linkSchemaVersion: 2, info});
  }
  if (apply && changes.length) rebuildFinalArtifacts(source, mappingIndex, manifest, revision, dataRoot);
  return {mode: apply ? 'applied' : 'dry-run', changed: changes.length,
    examples: changes.slice(0, 10)};
}

if (require.main === module) {
  try { console.log(migrateLinks({apply: process.argv.includes('--apply')})); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = {migrateLinks};
