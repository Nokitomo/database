'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {DATA, file, hash, iso, listIds, parseArgs, readJson, sleep, writeJson} = require('./lib');
const {archiveItems, discover, fetchAnime} = require('./source');
const {enrichAnime, mapAnime} = require('./vega');

function stageIndex(stage) { return path.join(DATA, stage, 'index.json'); }
function providerRef() { return fs.readFileSync(path.join(__dirname, '..', 'vega-providers.ref'), 'utf8').trim(); }
function isDynamic(raw) { return /in corso|ongoing|in uscita|upcoming|prossimamente/i.test(raw.info?.status || raw.embeddedAnime?.status || ''); }
function due(raw, full, fullSince = null) {
  if (!raw) return true;
  if (full && (!fullSince || Date.parse(raw.checkedAt || 0) < fullSince)) return true;
  const age = Date.now() - Date.parse(raw.checkedAt || 0);
  return !Number.isFinite(age) || age > (isDynamic(raw) ? 24 : 30 * 24) * 3600000;
}
function enrichmentDue(final, now = Date.now()) {
  if (!final) return true;
  const age = now - Date.parse(final.updatedAt || 0);
  if (!Number.isFinite(age)) return true;
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
  const archiveDue = shouldRefreshArchive(previousIndex, options.full, Date.now(), options.fullSince);
  const archive = archiveDue ? await archiveItems(discovery.baseUrl) : null;
  const merged = new Map(discovery.sitemap);
  if (archive) {
    for (const [id, item] of archive.items) merged.set(id, item);
  } else {
    for (const item of previousIndex.archiveOnly || []) merged.set(item.id, item);
  }
  const expectedIds = [...merged.keys()].sort((a, b) => a - b);
  if (expectedIds.length < 1000) throw new Error(`Archive unexpectedly small: ${expectedIds.length}`);
  const expected = new Set(expectedIds);
  const archiveOnly = archive
    ? [...archive.items.values()].filter(item => !discovery.sitemap.has(item.id))
    : previousIndex.archiveOnly || [];
  const index = {schemaVersion: 1, discoveredAt: iso(), baseUrl: discovery.baseUrl,
    discoverySource: discovery.source, pastebinUrl: discovery.pasteUrl,
    sitemapCount: discovery.sitemap.size, archiveCount: archive?.items.size ?? previousIndex.archiveCount,
    archiveReportedTotal: archive?.total ?? previousIndex.archiveReportedTotal,
    archiveCheckedAt: archive ? iso() : previousIndex.archiveCheckedAt, archiveOnly,
    expectedIds, checkedIds: previousIndex.checkedIds || [],
    errors: Object.fromEntries(Object.entries(previousIndex.errors || {}).filter(([id]) => expected.has(Number(id))))};
  writeJson(stageIndex('raw'), index);
  const pending = expectedIds.filter(id => (!options.ids || options.ids.has(id)) &&
    errorDue(index.errors[id]) && due(readJson(file('raw', id)), options.full, options.fullSince));
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
    try {
      const item = merged.get(id);
      const source = await fetchAnime(item, discovery.baseUrl);
      const previous = readJson(file('raw', id));
      const fingerprint = hash({info: source.info, embeddedAnime: source.embeddedAnime, episodes: source.episodes});
      writeJson(file('raw', id), {...source, archiveRecord: item.archiveRecord || previous?.archiveRecord || null,
        checkedAt: iso(), fingerprint, changedAt: previous?.fingerprint === fingerprint ? previous.changedAt : iso()});
      delete index.errors[id];
    } catch (error) {
      index.errors[id] = {at: iso(), message: error.message};
      console.error(`raw ${id}: ${error.message}`);
    }
    if ((position + 1) % 20 === 0) {writeJson(stageIndex('raw'), index); console.log(`raw: ${position + 1}/${selected.length}`);}
    await sleep(200);
  }
  const available = new Set(listIds('raw'));
  index.checkedIds = expectedIds.filter(id => available.has(id));
  index.complete = index.checkedIds.length === expectedIds.length && Object.keys(index.errors).length === 0;
  index.finishedAt = iso();
  writeJson(stageIndex('raw'), index);
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
  const expected = new Set(source.expectedIds);
  index.errors = Object.fromEntries(Object.entries(index.errors || {}).filter(([id]) => expected.has(Number(id))));
  const pending = source.expectedIds.filter(id => {
    if (options.ids && !options.ids.has(id)) return false;
    const raw = readJson(file('raw', id));
    if (!raw) return false;
    const mapped = readJson(file('mapped', id));
    if (!errorDue(index.errors[id])) return false;
    return (options.full && (!options.fullSince || Date.parse(mapped?.mappedAt || 0) < options.fullSince)) || !mapped ||
      mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== revision;
  });
  pending.sort((a, b) => b - a);
  const selected = limited(pending, options.limit);
  console.log(`mapped: ${selected.length}/${pending.length} due`);
  for (const [position, id] of selected.entries()) {
    try {
      const raw = readJson(file('raw', id));
      const mapped = await mapAnime(providerRoot, source.baseUrl, raw);
      writeJson(file('mapped', id), {...mapped, rawFingerprint: raw.fingerprint,
        providerRef: revision, mappedAt: iso()});
      delete index.errors[id];
    } catch (error) { index.errors[id] = {at: iso(), message: error.message}; console.error(`mapped ${id}: ${error.message}`); }
    if ((position + 1) % 20 === 0) {writeJson(stageIndex('mapped'), index); console.log(`mapped: ${position + 1}/${selected.length}`);}
    await sleep(100);
  }
  index.expectedCount = source.expectedIds.length;
  index.availableCount = source.expectedIds.filter(id => {
    const raw = readJson(file('raw', id));
    const mapped = readJson(file('mapped', id));
    return raw && mapped?.rawFingerprint === raw.fingerprint && mapped?.providerRef === revision;
  }).length;
  index.providerRef = revision;
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
  const manifest = readJson(path.join(DATA, 'final', 'manifest.json'), {schemaVersion: 1, errors: {}});
  const revision = providerRef();
  const expected = new Set(source.expectedIds);
  manifest.errors = Object.fromEntries(Object.entries(manifest.errors || {}).filter(([id]) => expected.has(Number(id))));
  const pending = source.expectedIds.filter(id => {
    if (options.ids && !options.ids.has(id)) return false;
    const raw = readJson(file('raw', id));
    const mapped = readJson(file('mapped', id));
    if (!raw || !mapped || mapped.rawFingerprint !== raw.fingerprint || mapped.providerRef !== revision) return false;
    const final = readJson(file('final', id));
    if (!errorDue(manifest.errors[id])) return false;
    return (options.full && (!options.fullSince || Date.parse(final?.updatedAt || 0) < options.fullSince)) ||
      !final || final.providerRef !== revision ||
      final.rawFingerprint !== raw.fingerprint || final.mappingFingerprint !== hash(mapped) ||
      enrichmentDue(final);
  });
  const episodeCounts = new Map(pending.map(id => [id, readJson(file('raw', id))?.episodes?.length || 0]));
  pending.sort((a, b) => {
    return episodeCounts.get(a) - episodeCounts.get(b) || b - a;
  });
  const selected = limited(pending, options.limit);
  console.log(`final: ${selected.length}/${pending.length} due`);
  for (const [position, id] of selected.entries()) {
    try {
      const raw = readJson(file('raw', id));
      const mapped = readJson(file('mapped', id));
      const final = await enrichAnime(providerRoot, source.baseUrl, raw, mapped);
      writeJson(file('final', id), {...final, rawFingerprint: raw.fingerprint,
        mappingFingerprint: hash(mapped), providerRef: revision});
      delete manifest.errors[id];
    } catch (error) { manifest.errors[id] = {at: iso(), message: error.message}; console.error(`final ${id}: ${error.message}`); }
    if ((position + 1) % 10 === 0) {writeJson(path.join(DATA, 'final', 'manifest.json'), manifest); console.log(`final: ${position + 1}/${selected.length}`);}
    await sleep(100);
  }
  const records = source.expectedIds.map(id => {
    const raw = readJson(file('raw', id));
    const mapped = readJson(file('mapped', id));
    const final = readJson(file('final', id));
    return raw && mapped?.providerRef === revision && final?.providerRef === revision &&
      final?.rawFingerprint === raw.fingerprint && final?.mappingFingerprint === hash(mapped) ? final : null;
  }).filter(Boolean);
  const catalog = records.map(catalogEntry);
  writeJson(path.join(DATA, 'final', 'catalog.json'), {schemaVersion: 1, records: catalog});
  const shards = new Map();
  for (const record of records) {
    const key = String(record.id % 100).padStart(2, '0');
    const bucket = shards.get(key) || [];
    bucket.push({id: record.id, path: record.path, info: record.info, episodes: record.episodes});
    shards.set(key, bucket);
  }
  const shardHashes = {};
  for (const [key, bucket] of shards) {
    bucket.sort((a, b) => a.id - b.id);
    const payload = {schemaVersion: 1, records: bucket};
    writeJson(path.join(DATA, 'final', 'shards', `${key}.json`), payload);
    shardHashes[key] = hash(payload);
  }
  manifest.generatedAt = iso();
  manifest.baseUrlSnapshot = source.baseUrl;
  manifest.expectedCount = source.expectedIds.length;
  manifest.availableCount = records.length;
  manifest.complete = source.complete && mappingIndex.complete && records.length === source.expectedIds.length && Object.keys(manifest.errors).length === 0;
  manifest.providerRef = revision;
  manifest.catalogSha256 = hash(catalog);
  manifest.itemHashes = Object.fromEntries(records.map(record => [record.id, hash(record)]));
  manifest.shardHashes = shardHashes;
  writeJson(path.join(DATA, 'final', 'manifest.json'), manifest);
  manifest.selectedCount = selected.length;
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const providerRoot = options.stage === 'raw' ? null : requireProviderRoot(options);
  let result;
  const selected = {};
  if (options.stage === 'raw' || options.stage === 'all') { result = await runRaw(options); selected.raw = result.selectedCount; }
  if (options.stage === 'mapped' || options.stage === 'all') { result = await runMapped(options, providerRoot); selected.mapped = result.selectedCount; }
  if (options.stage === 'final' || options.stage === 'all') { result = await runFinal(options, providerRoot); selected.final = result.selectedCount; }
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
module.exports = {catalogEntry, due, enrichmentDue, errorDue, runRaw, runMapped, runFinal, shouldRefreshArchive};
