'use strict';

const path = require('node:path');
const {read, write, hash} = require('../../providers/animeworld/scripts/store');
const {hash: legacyHash} = require('../../scripts/lib');
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function format(record) {
  const value = String(record.sourceMetadata?.info?.type || record.info?.type || '').toLowerCase();
  if (/movie|film/.test(value)) return 'movie';
  if (/special/.test(value)) return 'special';
  if (/ova|ona/.test(value)) return value;
  return /tv|series|serie/.test(value) ? 'series' : null;
}
function ids(record) {
  const source = record.sourceIds || {}, info = record.sourceMetadata?.info || record.info;
  return {anilist: validId(source.anilistId ?? source.anilist ?? info?.anilist_id),
    mal: validId(source.malId ?? source.mal ?? info?.mal_id)};
}
function compatible(a, b) {
  const x = ids(a), y = ids(b);
  const shared = Object.keys(x).some(key => x[key] && x[key] === y[key]);
  const conflict = Object.keys(x).some(key => x[key] && y[key] && x[key] !== y[key]);
  return shared && !conflict && !(format(a) && format(b) && format(a) !== format(b));
}
function namespace(value, provider) {
  if (Array.isArray(value)) return value.map(item => namespace(item, provider));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'base' && typeof item === 'string' ? `${provider}:${item}` : namespace(item, provider)]));
}
function loadSources(auRoot, awRoot, additionalSources = {}) {
  const auManifest = read(path.join(auRoot, 'final/manifest.json'));
  const auIndex = read(path.join(auRoot, 'raw/index.json'));
  const awManifest = read(path.join(awRoot, 'manifest.json'));
  if (!auManifest || !auIndex || !awManifest) throw new Error('Both provider snapshots are required; refusing an incomplete replacement');
  const entries = [];
  // Include raw AnimeUnity records still waiting for enrichment: they already
  // establish provider presence and must not be misclassified as AW-exclusive.
  for (const id of auIndex.expectedIds) {
    const final = read(path.join(auRoot, `final/items/${id}.json`));
    if (auManifest.itemHashes[id] && (!final || legacyHash(final) !== auManifest.itemHashes[id]))
      throw new Error(`AnimeUnity snapshot hash mismatch: ${id}`);
    const raw = read(path.join(auRoot, `raw/items/${id}.json`));
    if (raw || final) entries.push({provider: 'animeunity', id,
      record: {...(final || raw), sourceIds: ids(raw || final)}, enriched: Boolean(final), raw});
  }
  for (const [id, expected] of Object.entries(awManifest.itemHashes)) {
    const record = read(path.join(awRoot, `items/${id}.json`));
    if (!record || hash(record) !== expected) throw new Error(`AnimeWorld snapshot hash mismatch: ${id}`);
    entries.push({provider: 'animeworld', id: Number(id), record, enriched: false});
  }
  const manifests={animeunity:auManifest,animeworld:awManifest};
  const origins={animeunity:{site:auIndex.baseUrl},animeworld:awManifest.origins};
  for(const [provider,root] of Object.entries(additionalSources)){
    if(provider!=='animesaturn')throw new Error('Unsupported additional provider');
    const manifest=read(path.join(root,'manifest.json'));
    if(!manifest||manifest.provider!==provider)throw new Error(`Missing ${provider} snapshot; refusing to drop its membership`);
    for(const [id,expected] of Object.entries(manifest.itemHashes)){
      if(!/^[A-Za-z0-9]{5}$/.test(id))throw new Error('Invalid AnimeSaturn identity');
      const record=read(path.join(root,'items',id+'.json'));
      if(!record||record.id!==id||hash(record)!==expected)throw new Error(`${provider} snapshot hash mismatch: ${id}`);
      entries.push({provider,id,record,enriched:false});
    }
    manifests[provider]=manifest;origins[provider]=manifest.origins;
  }
  return {entries,manifests,origins};
}
function groupEntries(entries, registry = {members: {}, nextId: 1}, overrides = {}) {
  const groups = [], conflicts = [], byExternalId = new Map(), byCanonicalId = new Map();
  for (const entry of [...entries].sort((a,b) =>
    Number(Boolean(registry.members[`${b.provider}:${b.id}`])) - Number(Boolean(registry.members[`${a.provider}:${a.id}`])) ||
    a.provider.localeCompare(b.provider) || String(a.id).localeCompare(String(b.id),undefined,{numeric:true}))) {
    entry.key = `${entry.provider}:${entry.id}`;
    const direct = ids(entry.record);
    const keys = Object.entries(direct).filter(([,id])=>id).map(([service,id])=>`${service}:${id}`);
    const matches = [...new Set(keys.flatMap(key=>[...(byExternalId.get(key)||[])]))];
    const safe = matches.filter(group => group.entries.every(other => {
      const a = ids(entry.record), b = ids(other.record);
      return !Object.keys(a).some(key => a[key] && b[key] && a[key] !== b[key]) &&
        !(format(entry.record) && format(other.record) && format(entry.record) !== format(other.record));
    }));
    const forced = overrides[entry.key];
    let group = forced ? byCanonicalId.get(forced) : safe.length === 1 && matches.length === 1 ? safe[0] : null;
    if (matches.length && !group && !forced) conflicts.push({member: entry.key, candidates: matches.map(value => value.id)});
    if (!group) {
      const id = forced || registry.members[entry.key] || `work-${registry.nextId++}`;
      if (!/^work-\d+$/.test(id)) throw new Error('Invalid canonical ID override');
      // Previously linked identities that now conflict must split safely.
      group = {id: byCanonicalId.has(id) ? `work-${registry.nextId++}` : id, entries: []};
      groups.push(group);
      byCanonicalId.set(group.id,group);
    }
    group.entries.push(entry);
    registry.members[entry.key] = group.id;
    for(const key of keys){if(!byExternalId.has(key))byExternalId.set(key,new Set());byExternalId.get(key).add(group);}
  }
  return {groups, registry, conflicts};
}
function baseRecord(group) {
  const primary = group.entries.filter(entry => entry.provider === 'animeunity' && entry.enriched)
    .sort((a,b) => (b.record.episodes?.length || 0)-(a.record.episodes?.length || 0))[0] ||
    group.entries.find(entry => entry.provider === 'animeunity') || group.entries[0];
  const result = structuredClone(primary.record);
  if(primary.provider==='animeunity'&&!primary.enriched){
    result.info={...result.info,title:result.info.title_eng||result.info.title||result.info.title_it,
      synopsis:result.info.plot||result.info.synopsis,poster:result.info.imageurl||result.info.cover,
      background:result.info.imageurl_cover};
  }
  result.info.title ||= group.entries.map(entry=>entry.record.info?.title).find(Boolean);
  const providers = {animeunity: [], animeworld: [], animesaturn: []};
  const providerImages = {animeworld: [], animesaturn: []};
  for (const entry of group.entries) {
    providers[entry.provider].push({id: entry.id, path: entry.record.path,
      audio: entry.record.info?.audio ?? (entry.raw?.info?.dub ? 'Italiano' : null),
      dubbed: entry.record.info?.dubbed ?? Boolean(entry.raw?.info?.dub),
      episodes: namespace(entry.record.sourceEpisodes || entry.record.episodes || [], entry.provider)});
    if (providerImages[entry.provider]) providerImages[entry.provider].push(...namespace(entry.record.images || [], entry.provider));
  }
  return {id: group.id, sourceIds: ids(primary.record), info: namespace(result.info, primary.provider),
    episodes: namespace(result.episodes || [], primary.provider), mappings: result.mappings,
    artworkInventory: namespace(result.artworkInventory || {}, primary.provider), artworkLibrary: result.artworkLibrary,
    providers, availability: Object.fromEntries(Object.entries(providers).map(([key, values]) =>
      [key, values.length ? 'present' : 'not_matched'])), providerImages,
    metadataProvider: primary.provider, enrichment: {status: primary.enriched ? 'ready' : 'pending'}};
}
function publish(root, records, source, registry, conflicts) {
  const catalog = [], itemHashes = {}, shards = Array.from({length: 100}, () => []);
  for (const record of records.sort((a,b)=>a.id.localeCompare(b.id))) {
    write(path.join(root, 'items', `${record.id}.json`), record);
    itemHashes[record.id] = hash(record);
    shards[Number(record.id.slice(5)) % 100].push(record);
    catalog.push({id: record.id, title: record.info?.title, poster: record.info?.poster,
      providers: Object.keys(record.providers).filter(key => record.providers[key].length), enrichment: record.enrichment.status});
  }
  const old = read(path.join(root, 'manifest.json'), {itemHashes: {}});
  const origins = Object.fromEntries(Object.entries(source.origins).flatMap(([provider, values]) =>
    Object.entries(values).map(([key,value]) => [`${provider}:${key}`, value])));
  const shardHashes = {};
  shards.forEach((items,index) => {
    const name = String(index).padStart(2,'0');
    write(path.join(root, 'shards', `${name}.json`), items);
    shardHashes[name] = hash(items);
  });
  const manifest = {schemaVersion: 1, itemHashes, shardHashes, origins, catalogHash: hash(catalog), count: records.length,
    complete: Object.values(source.manifests).every(value => value.complete) && !conflicts.length && records.every(value => value.enrichment.status === 'ready'),
    sourceSnapshots: Object.fromEntries(Object.entries(source.manifests).map(([key,value]) => [key, hash(value)])),
    conflicts, pendingCount: records.filter(value => value.enrichment.status !== 'ready').length};
  write(path.join(root, 'catalog.json'), catalog);
  write(path.join(root, 'registry.json'), registry);
  // Keep inactive item files for later reactivation; membership is manifest-only.
  // Clients diff their own itemHashes against the latest manifest, even after months offline.
  write(path.join(root, 'changes.json'), {from: hash(old.itemHashes), to: hash(itemHashes),
    changed: Object.keys(itemHashes).filter(id => old.itemHashes[id] !== itemHashes[id]),
    removed: Object.keys(old.itemHashes).filter(id => !itemHashes[id])});
  write(path.join(root, 'manifest.json'), manifest);
  return manifest;
}
module.exports = {ids, compatible, namespace, loadSources, groupEntries, baseRecord, publish};
