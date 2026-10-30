'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DEFAULT_DATA = path.resolve(__dirname, '..', 'data');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function read(file, fallback = null) {
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return fallback; throw error;}
}
function write(file, value) {
  const body = JSON.stringify(value) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = file + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}
const itemFile = (root, id) => path.join(root, 'items', `${id}.json`);
function initialState() {
  return {schemaVersion: 1, provider: 'animeworld', known: {}, records: {}, origins: {},
    archive: {}, feeds: {}, extras: {images: {}, schedule: {}}, errors: {}};
}
function activeIds(state) {return Object.values(state.known).filter(item => item.active).map(item => item.id).sort((a,b) => a-b);}
function archiveSignature(card) {
  const {token, episodeLabel, ...data} = card;
  return hash(data);
}
function observe(state, card, now, force = false, source = 'archive') {
  const prior = state.known[card.id];
  if (prior && prior.code !== card.code) throw new Error(`Provider identity changed for ${card.id}`);
  const signature = archiveSignature(card);
  state.known[card.id] = {...prior, ...card, active: true,
    fingerprints: {...prior?.fingerprints, [source]: signature},
    firstSeenAt: prior?.firstSeenAt || now, lastSeenAt: now, missingScanAt: null,
    forceRefresh: Boolean(force || prior?.forceRefresh || (prior && (!prior.active || prior.path !== card.path ||
      prior.fingerprints?.[source] && prior.fingerprints[source] !== signature)))};
  return state.known[card.id];
}

function publish(root, state, status, now = Date.now()) {
  const ids = activeIds(state), records = ids.map(id => read(itemFile(root, id))).filter(Boolean);
  const catalog = records.map(record => ({id: record.id, code: record.code, path: record.path,
    title: record.info.title, originalTitle: record.info.originalTitle, poster: record.info.poster,
    type: record.info.type, status: record.info.status, year: record.info.year,
    genres: record.info.genres, audio: record.info.audio, dubbed: record.info.dubbed,
    episodeCount: record.episodes.length}));
  const shardHashes = {}, groups = Array.from({length: 100}, () => []);
  for (const record of records) groups[record.id % 100].push(record);
  groups.forEach((group, index) => {
    const name = String(index).padStart(2, '0');
    write(path.join(root, 'shards', `${name}.json`), group);
    shardHashes[name] = hash(group);
  });
  write(path.join(root, 'catalog.json'), catalog);
  const manifest = {schemaVersion: 1, provider: 'animeworld', generatedAt: new Date(now).toISOString(),
    origins: state.origins, discovery: state.discovery, archiveTotal: state.archive.total || null,
    archiveCheckedAt: state.archive.completedAt || null, archiveScanPage: state.archive.scan?.nextPage || null,
    expectedCount: ids.length, availableCount: records.length,
    complete: Boolean(status.complete), pendingCount: status.pendingCount,
    inactiveIds: Object.values(state.known).filter(item => !item.active).map(item => item.id).sort((a,b)=>a-b),
    recordErrors: Object.fromEntries(ids.filter(id => state.records[id]?.error).map(id => [id, state.records[id].error])),
    discoveryErrors: state.errors, catalogHash: hash(catalog), shardHashes,
    itemHashes: Object.fromEntries(records.map(record => [record.id, hash(record)]))};
  write(path.join(root, 'manifest.json'), manifest);
  return manifest;
}

module.exports = {DEFAULT_DATA, hash, read, write, itemFile, initialState, activeIds, observe, archiveSignature, publish};
