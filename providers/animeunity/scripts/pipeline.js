'use strict';
const {needsEpisodeIdentity} = require('./episode-safety');

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {DATA, file, hash, iso, listIds, parseArgs, readJson, sleep, writeJson} = require('./lib');
const {archiveItems, discover, fetchAnime, verifyAnimeUnavailable} = require('./source');
const {initialDiscoveryState, mergeDiscoveredItems, reconcileDiscovery} = require('./discovery-state');
const {createContext, enrichAnime, mapAnime, requireProvider} = require('./vega');
const {buildQualityReport} = require('./quality');
const {withRecordDeadline} = require('./record-deadline');
const {maintainImages, applyImageReplacements} = require('./image-health');
const {mappingFingerprint, matchesMapping, migrateFinalMapping, finalIsCurrent,
  publishable, consumerContent, ENRICHMENT_SCHEMA_VERSION} = require('./incremental');

function stageIndex(stage) { return path.join(DATA, stage, 'index.json'); }
function finalProgressFile(id) { return path.join(DATA, 'final', 'progress', `${id}.json`); }
function providerRef() { return fs.readFileSync(path.join(DATA, 'vega-providers.ref'), 'utf8').trim(); }
function matchingFinalProgress(progress, rawFingerprint, mappingFingerprint, revision, rawPath) {
  return progress?.rawFingerprint === rawFingerprint && progress?.mappingFingerprint === mappingFingerprint &&
    progress?.providerRef === revision && (!rawPath || progress.path === rawPath) &&
    Number.isInteger(progress?.nextGroup) && progress.nextGroup >= 0 &&
    progress?.info && Array.isArray(progress.info.linkList) &&
    progress.nextGroup <= progress.info.linkList.filter(group => group.episodesLink).length &&
    Array.isArray(progress.episodes);
}
function mappingDue(raw, mapped, revision, sourceHash, full = false, fullSince = null) {
  return (full && (!fullSince || Date.parse(mapped?.checkedAt || mapped?.mappedAt || 0) < fullSince)) || !mapped ||
    mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== revision ||
    mapped.mappingSourceHash !== sourceHash;
}

async function aniBridgeSourceHash(providerRoot, baseUrl) {
  const {getAniBridgeIndex} = requireProvider(providerRoot, 'mappings/anibridge.js');
  const index = await getAniBridgeIndex(createContext(providerRoot, baseUrl));
  if (!index?.schemaVersion || !index.records?.size) throw new Error('AniBridge index unavailable');
  return hash([...index.records.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
function isDynamic(raw) {
  return Number(raw.info?.episodes_count) === 0 && raw.episodes?.length === 0 ||
    /in corso|ongoing|in uscita|upcoming|prossimamente/i.test(raw.info?.status || raw.embeddedAnime?.status || '');
}
function due(raw, full, fullSince = null, expectedPath = null) {
  if (!raw) return true;
  if (expectedPath && raw.path !== expectedPath) return true;
  if (full && (!fullSince || Date.parse(raw.checkedAt || 0) < fullSince)) return true;
  const age = Date.now() - Date.parse(raw.checkedAt || 0);
  return !Number.isFinite(age) || age > (isDynamic(raw) ? 24 : 30 * 24) * 3600000;
}
function enrichmentDue(final, now = Date.now()) {
  if (!final) return true;
  if (Object.values(final.metadataTasks || {}).some(task =>
    Number.isFinite(task.nextCheckAt) && now >= task.nextCheckAt)) return true;
  const age = now - Date.parse(final.updatedAt || 0);
  if (!Number.isFinite(age)) return true;
  if (final.sourceStatus?.tmdbWeb?.transientFailures > 0) {
    const failures = Math.max(1, Number(final.sourceStatus.tmdbWeb.retryCount) || 1);
    const retryDelay = Math.min(24 * 3600000, 30 * 60000 * 2 ** Math.min(failures - 1, 6));
    if (age > retryDelay) return true;
  }
  const missingArtwork = !final.info?.logo || !final.info?.poster || !final.info?.background;
  const missingEpisodeMetadata = (final.episodes || []).some(episode =>
    !episode.synopsis || !episode.thumbnail || !episode.title || /^Episodes? \d/i.test(episode.title));
  return age > (missingArtwork || missingEpisodeMetadata ? 30 : 90) * 86400000;
}
function limited(items, limit) { return Number.isFinite(limit) ? items.slice(0, limit) : items; }
function errorDue(error, now = Date.now()) {
  return !error || !Number.isFinite(Date.parse(error.at || 0)) ||
    now - Date.parse(error.at) >= 30 * 60000;
}
function shouldRefreshArchive(index, full, now = Date.now(), fullSince = null) {
  return (full && (!fullSince || Date.parse(index.archiveCheckedAt || 0) < fullSince)) ||
    !index.archiveCheckedAt || now - Date.parse(index.archiveCheckedAt) > 24 * 3600000;
}
function catalogEntry(record) {
  const source = record.sourceMetadata?.info || {};
  const embedded = record.sourceMetadata?.embedded || {};
  const archive = record.sourceMetadata?.archive || {};
  const latest = [...(record.sourceEpisodes || [])].sort((a, b) =>
    Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0) || Number(b.id || 0) - Number(a.id || 0))[0];
  return {
    id: record.id, path: record.path, title: record.info.title,
    image: record.info.poster || record.info.image, rating: record.info.rating || null,
    type: source.type || embedded.type || archive.type || null,
    status: source.status || embedded.status || archive.status || null,
    year: String(source.date || embedded.date || archive.date || '').match(/\d{4}/)?.[0] || null,
    season: source.season || embedded.season || archive.season || null,
    genres: record.info.genres || [], tags: record.info.tags || [],
    studio: source.studio || embedded.studio || null,
    episodesCount: record.info.episodesCount || 0,
    score: source.score || embedded.score || null,
    favorites: embedded.favorites || archive.favorites || null,
    members: embedded.members || archive.members || null,
    views: embedded.visite || archive.visite || null,
    dubbed: Boolean(Number(source.dub ?? embedded.dub ?? archive.dub ?? 0)),
    broadcastDay: embedded.day || null,
    artworkHints: {anilistId: record.sourceIds?.anilistId || undefined,
      malId: record.sourceIds?.malId || undefined, isMovie: record.info.type === 'movie'},
    latestEpisode: latest ? {id: latest.id, number: latest.number,
      uploadedAt: latest.created_at || null} : null,
  };
}

async function runRaw(options) {
  const discovery = await discover();
  const previousIndex = readJson(stageIndex('raw'), {});
  const statePath = path.join(DATA, 'raw', 'discovery-state.json');
  const savedState = readJson(statePath);
  // Recover records omitted by the sitemap during the first deployment.
  const previousState = savedState || initialDiscoveryState(previousIndex,
    listIds('raw').map(id => readJson(file('raw', id))).filter(Boolean));
  const now = Date.now();
  const archiveDue = (!previousState.archiveRetryAt || now >= Date.parse(previousState.archiveRetryAt)) &&
    (!previousState.archive || shouldRefreshArchive({archiveCheckedAt: previousState.archive.checkedAt},
      options.full, now, options.fullSince));
  let archive = null;
  let archiveError = previousIndex.archiveError || null;
  if (archiveDue) {
    try { archive = await archiveItems(discovery.baseUrl); archiveError = null; }
    catch (error) {
      archiveError = {at: iso(), message: error.message};
      console.error(`raw archive: ${error.message}; retaining the previous discovery state`);
    }
  }
  const reconciliation = await reconcileDiscovery({sitemap: discovery.sitemap, archive,
    state: previousState, verifyUnavailable: (id, item) =>
      verifyAnimeUnavailable(id, item, discovery.baseUrl)});
  if (archiveError) reconciliation.state.archiveRetryAt = archiveDue
    ? new Date(now + 30 * 60000).toISOString() : previousState.archiveRetryAt;
  const nextState = reconciliation.state;
  if (JSON.stringify(nextState) !== JSON.stringify(savedState)) writeJson(statePath, nextState);
  const merged = reconciliation.merged;
  const archived = new Map((nextState.archive?.items || []).map(item => [item.id, item]));
  const expectedIds = [...merged.keys()].sort((a, b) => a - b);
  if (expectedIds.length < 1000) throw new Error(`Archive unexpectedly small: ${expectedIds.length}`);
  const expected = new Set(expectedIds);
  const archiveOnly = [...archived.values()].filter(item => !discovery.sitemap.has(item.id));
  const index = {schemaVersion: 1, discoveredAt: iso(), baseUrl: discovery.baseUrl,
    discoverySource: discovery.source, pastebinUrl: discovery.pasteUrl,
    sitemapCount: discovery.sitemap.size, archiveCount: archived.size || previousIndex.archiveCount,
    archiveReportedTotal: nextState.archive?.total ?? previousIndex.archiveReportedTotal,
    archiveCheckedAt: nextState.archive?.checkedAt ?? previousIndex.archiveCheckedAt,
    archiveError, archiveOnly, inactiveIds: Object.keys(nextState.inactive).map(Number).sort((a, b) => a - b),
    expectedIds, checkedIds: previousIndex.checkedIds || [],
    errors: Object.fromEntries(Object.entries(previousIndex.errors || {}).filter(([id]) => expected.has(Number(id))))};
  writeJson(stageIndex('raw'), index);
  const pending = expectedIds.filter(id => (!options.ids || options.ids.has(id)) &&
    errorDue(index.errors[id]) && (nextState.reactivationPending[id] ||
      due(readJson(file('raw', id)), options.full, options.fullSince, merged.get(id)?.path)));
  const pendingRaw = new Map(pending.map(id => [id, readJson(file('raw', id))]));
  pending.sort((a, b) => {
    const left = pendingRaw.get(a);
    const right = pendingRaw.get(b);
    const tier = value => !value ? 0 : isDynamic(value) ? 1 : 2;
    if (options.full && Boolean(left) !== Boolean(right)) return left ? -1 : 1;
    return tier(left) - tier(right) || (left && right
      ? Date.parse(left.checkedAt || 0) - Date.parse(right.checkedAt || 0)
      : b - a);
  });
  const selected = limited(pending, options.limit);
  console.log(`raw: ${expectedIds.length} discovered, ${selected.length}/${pending.length} due, ${discovery.baseUrl} (${discovery.source})`);
  for (const [position, id] of selected.entries()) {
    console.log(`raw ${id}: starting`);
    try {
      const item = merged.get(id);
      if (!item.path) throw new Error(`Anime ${id} has no saved path; waiting for archive or sitemap`);
      const source = await withRecordDeadline(`raw ${id}`,
        signal => fetchAnime(item, discovery.baseUrl, undefined, signal));
      const previous = readJson(file('raw', id));
      const fingerprint = hash({info: source.info, embeddedAnime: source.embeddedAnime, episodes: source.episodes});
      writeJson(file('raw', id), {...source, archiveRecord: item.archiveRecord || previous?.archiveRecord || null,
        checkedAt: iso(), fingerprint, changedAt: previous?.fingerprint === fingerprint ? previous.changedAt : iso()});
      delete index.errors[id];
      delete nextState.reactivationPending[id];
    } catch (error) {
      index.errors[id] = {at: iso(), message: error.message};
      console.error(`raw ${id}: ${error.message}`);
    }
    if ((position + 1) % 20 === 0) {writeJson(stageIndex('raw'), index); console.log(`raw: ${position + 1}/${selected.length}`);}
    await sleep(200);
  }
  const available = new Set(listIds('raw'));
  index.checkedIds = expectedIds.filter(id => available.has(id));
  index.complete = !!nextState.archive && !archiveError &&
    Object.keys(nextState.reactivationPending).length === 0 &&
    index.checkedIds.length === expectedIds.length && Object.keys(index.errors).length === 0;
  index.finishedAt = iso();
  writeJson(stageIndex('raw'), index);
  if (JSON.stringify(nextState) !== JSON.stringify(readJson(statePath))) writeJson(statePath, nextState);
  index.selectedCount = selected.length;
  return index;
}

function requireProviderRoot(options) {
  const root = path.resolve(options.providerRoot || '');
  if (!options.providerRoot || !fs.existsSync(path.join(root, 'dist', 'animeunity', 'meta.js')))
    throw new Error('Pass --provider-root pointing to a built vega-providers checkout');
  const expected = providerRef();
  const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (actual !== expected) throw new Error(`vega-providers revision mismatch: ${actual} != ${expected}`);
  return root;
}

async function runMapped(options, providerRoot) {
  const source = readJson(stageIndex('raw'));
  if (!source) throw new Error('raw/index.json missing');
  const index = readJson(stageIndex('mapped'), {schemaVersion: 1, errors: {}});
  const revision = providerRef();
  const sourceHash = await aniBridgeSourceHash(providerRoot, source.baseUrl);
  const expected = new Set(source.expectedIds);
  index.errors = Object.fromEntries(Object.entries(index.errors || {}).filter(([id]) => expected.has(Number(id))));
  const pending = source.expectedIds.filter(id => {
    if (options.ids && !options.ids.has(id)) return false;
    const raw = readJson(file('raw', id));
    if (!raw) return false;
    const mapped = readJson(file('mapped', id));
    if (!errorDue(index.errors[id])) return false;
    return mappingDue(raw, mapped, revision, sourceHash, options.full, options.fullSince);
  });
  pending.sort((a, b) => b - a);
  const selected = limited(pending, options.limit);
  console.log(`mapped: ${selected.length}/${pending.length} due`);
  for (const [position, id] of selected.entries()) {
    console.log(`mapped ${id}: starting`);
    try {
      const raw = readJson(file('raw', id));
      const previous = readJson(file('mapped', id));
      const mapped = await withRecordDeadline(`mapped ${id}`,
        signal => mapAnime(providerRoot, source.baseUrl, raw, signal));
      const unchanged = previous && mappingFingerprint(previous) === mappingFingerprint(mapped);
      const next = {...mapped, rawFingerprint: raw.fingerprint, providerRef: revision,
        mappingSourceHash: sourceHash, mappedAt: unchanged ? previous.mappedAt : iso(), checkedAt: iso()};
      const final = readJson(file('final', id));
      const migrated = migrateFinalMapping(final, previous, next);
      if (migrated !== final) writeJson(file('final', id), migrated);
      writeJson(file('mapped', id), next);
      console.log(`mapped ${id}: ${unchanged ? 'content unchanged; final retained' : 'content changed; enrichment dependencies will be compared'}`);
      delete index.errors[id];
    } catch (error) { index.errors[id] = {at: iso(), message: error.message}; console.error(`mapped ${id}: ${error.message}`); }
    if ((position + 1) % 20 === 0) {writeJson(stageIndex('mapped'), index); console.log(`mapped: ${position + 1}/${selected.length}`);}
    await sleep(100);
  }
  index.expectedCount = source.expectedIds.length;
  index.availableCount = source.expectedIds.filter(id => {
    const raw = readJson(file('raw', id));
    const mapped = readJson(file('mapped', id));
    return raw && mapped?.rawFingerprint === raw.fingerprint && mapped?.providerRef === revision &&
      mapped?.mappingSourceHash === sourceHash;
  }).length;
  index.providerRef = revision;
  index.sourceHash = sourceHash;
  index.complete = source.complete && index.availableCount === index.expectedCount && Object.keys(index.errors).length === 0;
  index.finishedAt = iso();
  writeJson(stageIndex('mapped'), index);
  index.selectedCount = selected.length;
  return index;
}

async function runFinal(options, providerRoot) {
  const source = readJson(stageIndex('raw'));
  const mappingIndex = readJson(stageIndex('mapped'));
  if (!source || !mappingIndex) throw new Error('Raw and mapped stages required');
  const imageHealth = await maintainImages();
  const manifest = readJson(path.join(DATA, 'final', 'manifest.json'), {schemaVersion: 1, errors: {}});
  const revision = providerRef();
  const expected = new Set(source.expectedIds);
  manifest.errors = Object.fromEntries(Object.entries(manifest.errors || {}).filter(([id]) => expected.has(Number(id))));
  const pending = source.expectedIds.filter(id => {
    if (options.ids && !options.ids.has(id)) return false;
    const raw = readJson(file('raw', id));
    const mapped = readJson(file('mapped', id));
    if (!raw || !mapped || mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== revision ||
      mapped.mappingSourceHash !== mappingIndex.sourceHash) return false;
    const final = readJson(file('final', id));
    if (!errorDue(manifest.errors[id])) return false;
    return (options.full && (!options.fullSince || Date.parse(final?.updatedAt || 0) < options.fullSince)) ||
      !final || final.providerRef !== revision ||
      final.enrichmentSchemaVersion !== ENRICHMENT_SCHEMA_VERSION ||
      (final.episodeSafetyVersion !== 1 && raw.episodes.some(episode => needsEpisodeIdentity(episode.number))) ||
      final.rawFingerprint !== raw.fingerprint || !matchesMapping(final, mapped) ||
      final.path !== raw.path ||
      enrichmentDue(final);
  });
  const episodeCounts = new Map(pending.map(id => [id, readJson(file('raw', id))?.episodes?.length || 0]));
  pending.sort((a, b) => {
    return episodeCounts.get(a) - episodeCounts.get(b) || b - a;
  });
  const selected = limited(pending, options.limit);
  console.log(`final: ${selected.length}/${pending.length} due`);
  for (const [position, id] of selected.entries()) {
    console.log(`final ${id}: starting`);
    try {
      const raw = readJson(file('raw', id));
      const mapped = readJson(file('mapped', id));
      const fingerprint = mappingFingerprint(mapped);
      const savedProgress = readJson(finalProgressFile(id));
      const progress = matchingFinalProgress(savedProgress, raw.fingerprint, fingerprint, revision, raw.path)
        ? savedProgress : null;
      const previousFinal = readJson(file('final', id));
      const checkpoint = value => writeJson(finalProgressFile(id), {...value, path: raw.path,
        rawFingerprint: raw.fingerprint, mappingFingerprint: fingerprint,
        mappingFingerprintVersion: 2, providerRef: revision});
      const result = await withRecordDeadline(`final ${id}`,
        signal => enrichAnime(providerRoot, source.baseUrl, raw, mapped,
          {progress, previousFinal, checkpoint, maxGroups: 2, previousSourceStatus: previousFinal?.sourceStatus, signal}));
      if (result.partial) {
        writeJson(finalProgressFile(id), {...result.progress, path: raw.path, rawFingerprint: raw.fingerprint,
          mappingFingerprint: fingerprint, mappingFingerprintVersion: 2, providerRef: revision});
        const total = result.progress.info.linkList.filter(group => group.episodesLink).length;
        console.log(`final ${id}: episode groups ${result.progress.nextGroup}/${total} saved`);
      } else {
        writeJson(file('final', id), {...result, rawFingerprint: raw.fingerprint,
          mappingFingerprint: fingerprint, mappingFingerprintVersion: 2, providerRef: revision});
        if (result.sourceStatus?.tmdbWeb?.transientFailures) {
          console.log(`final ${id}: TMDB web had ${result.sourceStatus.tmdbWeb.transientFailures} temporary failures; retry scheduled`);
        }
        if (fs.existsSync(finalProgressFile(id))) fs.unlinkSync(finalProgressFile(id));
      }
      delete manifest.errors[id];
    } catch (error) { manifest.errors[id] = {at: iso(), message: error.message}; console.error(`final ${id}: ${error.message}`); }
    if ((position + 1) % 10 === 0) {writeJson(path.join(DATA, 'final', 'manifest.json'), manifest); console.log(`final: ${position + 1}/${selected.length}`);}
    await sleep(100);
  }
  const published = rebuildFinalArtifacts(source, mappingIndex, manifest, revision);
  published.selectedCount = selected.length;
  published.imageChecks = imageHealth.processed || imageHealth.checked;
  return published;
}

function rebuildFinalArtifacts(source, mappingIndex, manifest, revision, root = DATA) {
  const imageReplacements = readJson(path.join(root, 'image-health.json'))?.replacements || {};
  const recordFile = (stage, id) => path.join(root, stage, 'items', `${id}.json`);
  const pendingRefreshIds = [];
  const records = source.expectedIds.map(id => {
    const raw = readJson(recordFile('raw', id));
    const mapped = readJson(recordFile('mapped', id));
    const saved = readJson(recordFile('final', id));
    if (!publishable(saved, id)) return null;
    const final = applyImageReplacements(saved, imageReplacements);
    if (final !== saved) writeJson(recordFile('final', id), final);
    if (!finalIsCurrent(final, raw, mapped, revision) || mapped.mappingSourceHash !== mappingIndex.sourceHash ||
      final.enrichmentSchemaVersion !== ENRICHMENT_SCHEMA_VERSION)
      pendingRefreshIds.push(id);
    // Keep the previous coherent record visible until its replacement is ready.
    return final;
  }).filter(Boolean);
  const catalog = records.map(catalogEntry);
  writeJson(path.join(root, 'final', 'catalog.json'), {schemaVersion: 1, records: catalog});
  const shards = new Map();
  for (const record of records) {
    const key = String(record.id % 100).padStart(2, '0');
    const bucket = shards.get(key) || [];
    bucket.push(consumerContent(record));
    shards.set(key, bucket);
  }
  const shardHashes = {};
  for (const [key, bucket] of shards) {
    bucket.sort((a, b) => a.id - b.id);
    const payload = {schemaVersion: 1, records: bucket};
    writeJson(path.join(root, 'final', 'shards', `${key}.json`), payload);
    shardHashes[key] = hash(payload);
  }
  manifest.generatedAt = iso();
  manifest.enrichmentSchemaVersion = ENRICHMENT_SCHEMA_VERSION;
  manifest.baseUrlSnapshot = source.baseUrl;
  manifest.expectedCount = source.expectedIds.length;
  manifest.availableCount = records.length;
  manifest.pendingRefreshIds = pendingRefreshIds;
  manifest.complete = source.complete && mappingIndex.complete && pendingRefreshIds.length === 0 && records.length === source.expectedIds.length && Object.keys(manifest.errors).length === 0;
  manifest.providerRef = revision;
  manifest.catalogSha256 = hash(catalog);
  manifest.itemHashes = Object.fromEntries(records.map(record => [record.id, hash(record)]));
  manifest.contentHashes = Object.fromEntries(records.map(record => [record.id, hash(consumerContent(record))]));
  manifest.shardHashes = shardHashes;
  const quality = buildQualityReport(records, source, mappingIndex, manifest.errors, manifest.generatedAt);
  writeJson(path.join(root, 'final', 'quality.json'), quality);
  manifest.qualitySha256 = hash(quality);
  writeJson(path.join(root, 'final', 'manifest.json'), manifest);
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const providerRoot = options.stage === 'raw' ? null : requireProviderRoot(options);
  let result;
  const selected = {};
  if (options.stage === 'raw' || options.stage === 'all') { result = await runRaw(options); selected.raw = result.selectedCount; }
  if (options.stage === 'mapped' || options.stage === 'all') { result = await runMapped(options, providerRoot); selected.mapped = result.selectedCount; }
  if (options.stage === 'final' || options.stage === 'all') {
    result = await runFinal(options, providerRoot); selected.final = result.selectedCount;
    if (result.imageChecks) selected.images = result.imageChecks;
  }
  if (options.stage === 'raw' && selected.raw > 0) {
    for (const name of ['mapped/index.json', 'final/manifest.json']) {
      const target = path.join(DATA, name);
      const value = readJson(target);
      if (value?.complete) writeJson(target, {...value, complete: false});
    }
  } else if (options.stage === 'mapped' && selected.mapped > 0) {
    const target = path.join(DATA, 'final', 'manifest.json');
    const value = readJson(target);
    if (value?.complete) writeJson(target, {...value, complete: false});
  }
  if (Object.keys(result.errors || {}).length > 0 && !options.allowPartial) process.exitCode = 1;
  console.log(`${options.stage}: ${result.complete ? 'complete' : 'in progress'}, ${result.availableCount || result.checkedIds?.length || 0}/${result.expectedCount || result.expectedIds?.length || 0}`);
  console.log(`PIPELINE_BATCH ${JSON.stringify({selected, complete: result.complete})}`);
}

if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {catalogEntry, due, enrichmentDue, errorDue, mappingDue, matchingFinalProgress, mergeDiscoveredItems,
  rebuildFinalArtifacts, runRaw, runMapped, runFinal, shouldRefreshArchive};
