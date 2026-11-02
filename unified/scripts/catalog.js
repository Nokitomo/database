'use strict';

const path = require('node:path');
const {protectSourceEpisodes} = require('../../providers/animeunity/scripts/episode-safety');
const {read, write, hash} = require('../../providers/animeworld/scripts/store');
const {hash: legacyHash} = require('../../providers/animeunity/scripts/lib');
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
function normalizedTitle(value) {
  return typeof value === 'string' ? value.normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '') : '';
}
function identityTitles(record) {
  const source = record.sourceMetadata?.info || {};
  const info = record.info || {};
  return [...new Set([info.title, info.title_eng, info.title_it,
    source.title, source.title_eng, source.title_it]
    .map(normalizedTitle).filter(Boolean))];
}
function releaseYear(record) {
  const source = record.sourceMetadata?.info || {};
  const info = record.info || {};
  const value = info.year ?? source.date ?? info.date ??
    info.tags?.find(tag => /^(?:19|20)\d{2}$/.test(String(tag)));
  const match = String(value || '').match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}
function episodeCount(record) {
  const episodes = record.sourceEpisodes || record.episodes;
  return Array.isArray(episodes) && episodes.length ? episodes.length : null;
}
function titleCompatible(a, b) {
  const left = ids(a), right = ids(b);
  if (Object.keys(left).some(key => left[key] && right[key] && left[key] !== right[key])) return false;
  const leftYear = releaseYear(a), rightYear = releaseYear(b);
  const leftEpisodes = episodeCount(a), rightEpisodes = episodeCount(b);
  if (leftYear && rightYear && leftYear !== rightYear) return false;
  if (leftEpisodes && rightEpisodes && leftEpisodes !== rightEpisodes) return false;
  if (!(leftYear && rightYear || leftEpisodes && rightEpisodes)) return false;
  const leftMovie = format(a) === 'movie', rightMovie = format(b) === 'movie';
  return leftMovie === rightMovie;
}
function namespace(value, provider) {
  if (Array.isArray(value)) return value.map(item => namespace(item, provider));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'base' && typeof item === 'string' ? `${provider}:${item}` : namespace(item, provider)]));
}
function loadSources(auRoot, awRoot, additionalSources = {}, previouslyLoaded = []) {
  const auManifest = read(path.join(auRoot, 'final/manifest.json'));
  const auIndex = read(path.join(auRoot, 'raw/index.json'));
  const awManifest = read(path.join(awRoot, 'manifest.json'));
  if (!auManifest || !auIndex) throw new Error('AnimeUnity snapshot is required');
  if (!awManifest && (previouslyLoaded.includes('animeworld') || require('node:fs').existsSync(path.join(awRoot, 'manifest.json'))))
    throw new Error('Missing or invalid previously loaded AnimeWorld snapshot');
  if (awManifest && (!awManifest.itemHashes || typeof awManifest.itemHashes !== 'object' || Array.isArray(awManifest.itemHashes)))
    throw new Error('Invalid AnimeWorld snapshot manifest');
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
  for (const [id, expected] of Object.entries(awManifest?.itemHashes || {})) {
    const record = read(path.join(awRoot, `items/${id}.json`));
    if (!record || hash(record) !== expected) throw new Error(`AnimeWorld snapshot hash mismatch: ${id}`);
    entries.push({provider: 'animeworld', id: Number(id), record, enriched: false});
  }
  const manifests={animeunity:auManifest,...(awManifest?{animeworld:awManifest}:{})};
  const origins={animeunity:{site:auIndex.baseUrl},...(awManifest?{animeworld:awManifest.origins}:{})};
  for(const [provider,root] of Object.entries(additionalSources)){
    if(!['animesaturn','animetop'].includes(provider))throw new Error('Unsupported additional provider');
    const manifest=read(path.join(root,'manifest.json'));
    if(!manifest && !previouslyLoaded.includes(provider) && !require('node:fs').existsSync(path.join(root,'manifest.json')))continue;
    if(provider==='animetop')require('../../providers/animetop/scripts/verify').verify(root);
    if(!manifest||manifest.provider!==provider)throw new Error(`Missing ${provider} snapshot; refusing to drop its membership`);
    for(const [id,expected] of Object.entries(manifest.itemHashes)){
      if(!(provider==='animetop'?/^[1-9]\d*$/:/^[A-Za-z0-9]{5}$/).test(id))throw new Error('Invalid provider identity');
      const record=read(path.join(root,'items',id+'.json'));
      if(!record||String(record.id)!==id||hash(record)!==expected)throw new Error(`${provider} snapshot hash mismatch: ${id}`);
      entries.push({provider,id,record,enriched:false});
    }
    manifests[provider]=manifest;origins[provider]=manifest.origins;
  }
  const inactiveIds = {animeunity: auIndex.inactiveIds || [], animeworld: awManifest?.inactiveIds || []};
  for (const [provider, manifest] of Object.entries(manifests)) inactiveIds[provider] ||= manifest.inactiveIds || [];
  return {entries,manifests,origins,inactiveIds};
}
function groupEntries(entries, registry = {members: {}, nextId: 1}, overrides = {}) {
  const groups = [], conflicts = [], byExternalId = new Map(), byCanonicalId = new Map();
  const animeunityByTitle = new Map();
  for (const entry of entries) if (entry.provider === 'animeunity') {
    for (const title of identityTitles(entry.record)) {
      if (!animeunityByTitle.has(title)) animeunityByTitle.set(title, new Set());
      animeunityByTitle.get(title).add(entry);
    }
  }
  for (const entry of [...entries].sort((a,b) =>
    Number(a.provider !== 'animeunity') - Number(b.provider !== 'animeunity') ||
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
    if (!group && !forced && !matches.length && entry.provider !== 'animeunity') {
      const candidates = new Set(identityTitles(entry.record)
        .flatMap(title => [...(animeunityByTitle.get(title) || [])])
        .filter(candidate => titleCompatible(entry.record, candidate.record)));
      if (candidates.size === 1) {
        const candidate = [...candidates][0];
        group = byCanonicalId.get(registry.members[`animeunity:${candidate.id}`]) || null;
      }
    }
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
    group.entries.find(entry => entry.provider === 'animeunity') || group.entries.find(entry=>entry.provider!=='animetop') || group.entries[0];
  const result = structuredClone(primary.record);
  if (primary.provider === 'animeunity' && primary.enriched) {
    const episodes = new Map((result.episodes || []).map(episode => [String(episode.link), episode]));
    protectSourceEpisodes(episodes, primary.raw?.episodes || result.sourceEpisodes || []);
    result.episodes = [...episodes.values()];
  }
  if(primary.provider==='animeunity'&&!primary.enriched){
    result.info={...result.info,title:result.info.title_eng||result.info.title||result.info.title_it,
      synopsis:result.info.plot||result.info.synopsis,poster:result.info.imageurl||result.info.cover,
      background:result.info.imageurl_cover};
  }
  result.info.title ||= group.entries.map(entry=>entry.record.info?.title).find(Boolean);
  const providers = {animeunity: [], animeworld: [], animesaturn: [], animetop: []};
  const providerImages = {animeworld: [], animesaturn: [], animetop: []};
  for (const entry of group.entries) {
    providers[entry.provider].push({id: entry.id, path: entry.record.path,
      sourceIdentity:{title:entry.record.info?.title||entry.record.info?.name,type:entry.record.info?.type,year:entry.record.info?.year},sourceIds:entry.record.sourceIds,collection:entry.record.collection,
      audio: entry.record.info?.audio ?? (entry.raw?.info?.dub ? 'Italiano' : null),
      dubbed: entry.record.info?.dubbed ?? Boolean(entry.raw?.info?.dub),
      episodeResolution: entry.record.collection?.episodeResolution || 'snapshot',
      episodes: namespace(entry.record.sourceEpisodes || entry.record.episodes || [], entry.provider),
      ...(entry.provider==='animetop'?{seasons:namespace(entry.record.seasons||[],entry.provider),sourceRows:namespace(entry.record.sourceRows||[],entry.provider),playback:namespace(entry.record.playback||[],entry.provider),info:namespace(entry.record.info,entry.provider),sourceIds:entry.record.sourceIds,warnings:entry.record.warnings}: {})});
    if (providerImages[entry.provider]) {
      const images=entry.provider==='animetop'?(entry.record.images||[]).map(({role,reference,...rest})=>({kind:role,url:reference,...rest})):entry.record.images||[];
      providerImages[entry.provider].push(...namespace(images, entry.provider));
    }
  }
  return {id: group.id, sourceIds: ids(primary.record), info: namespace(result.info, primary.provider),
    episodes: namespace(result.episodes || [], primary.provider), mappings: result.mappings,
    artworkInventory: namespace(result.artworkInventory || {}, primary.provider), artworkLibrary: result.artworkLibrary,
    providers, availability: Object.fromEntries(Object.entries(providers).map(([key, values]) =>
      [key, values.length ? 'present' : 'not_matched'])), providerImages,
    metadataProvider: primary.provider, enrichment: {status: primary.enriched ? 'ready' : 'pending'}};
}
function publish(root, records, source, registry, conflicts) {
  const old = read(path.join(root, 'manifest.json'), {itemHashes: {}, origins: {}});
  const previous = new Map();
  // Include legacy files excluded from the old manifest, so migration recovers
  // previously retired records too. Files are our own persisted checkpoints.
  const fs = require('node:fs');
  const dir = path.join(root, 'items');
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
    if (!/^work-\d+\.json$/.test(name)) continue;
    const value = read(path.join(dir, name));
    if (!value || value.id !== name.slice(0,-5)) throw new Error('Invalid retained item');
    if (old.itemHashes[value.id] && hash(value) !== old.itemHashes[value.id]) throw new Error('Corrupt retained item');
    previous.set(value.id, value);
  }
  const current = new Map(records.map(record => [record.id, record]));
  const freshIds = new Set(current.keys());
  for (const [id, prior] of previous) if (!current.has(id)) current.set(id, structuredClone(prior));
  records = [...current.values()].map(record => {
    const prior = previous.get(record.id);
    const fresh = freshIds.has(record.id);
    // Preserve the prior metadata snapshot when its provider has disappeared.
    // Fresh provider inventories remain authoritative and separate below.
    if (prior && fresh && !(record.providers[prior.metadataProvider] || []).length) {
      record = {...record, info: {...record.info, ...prior.info}, episodes: prior.episodes,
        mappings: prior.mappings, artworkInventory: prior.artworkInventory,
        artworkLibrary: prior.artworkLibrary, metadataProvider: prior.metadataProvider,
        enrichment: prior.enrichment};
    }
    record.providers = Object.fromEntries(['animeunity','animeworld','animesaturn','animetop'].map(provider => {
      const live = fresh ? record.providers[provider] || [] : [];
      const variants = new Map(live.map(value => [String(value.id), {...value, availability:(source.inactiveIds?.[provider]||[]).some(id=>String(id)===String(value.id))?'unavailable':'present'}]));
      for (const value of prior?.providers?.[provider] || []) if (!variants.has(String(value.id))) {
        const reassigned = registry.members[`${provider}:${value.id}`] && registry.members[`${provider}:${value.id}`] !== record.id;
        const unavailable = (source.inactiveIds?.[provider] || []).some(id => String(id) === String(value.id));
        variants.set(String(value.id), {...value, availability: reassigned ? 'reassigned' : unavailable ? 'unavailable' : value.availability === 'unavailable' ? 'unavailable' : 'unknown'});
      }
      return [provider, [...variants.values()]];
    }));
    record.availability = Object.fromEntries(Object.entries(record.providers).map(([provider, variants]) =>
      [provider, variants.some(v=>v.availability==='present') ? 'present' : variants.some(v=>v.availability==='unknown') ? 'unknown' : variants.length ? 'unavailable' : 'not_matched']));
    record.active = Object.values(record.availability).some(value => value === 'present' || value === 'unknown');
    if (prior?.providerImages) record.providerImages = Object.fromEntries(Object.keys({...prior.providerImages,...record.providerImages}).map(provider =>
      [provider, [...new Map([...(prior.providerImages[provider] || []), ...(record.providerImages?.[provider] || [])].map(value=>[hash(value),value])).values()]]));
    return record;
  });
  const catalog = [], itemHashes = {}, shards = Array.from({length: 100}, () => []);
  for (const record of records.sort((a,b)=>a.id.localeCompare(b.id))) {
    write(path.join(root, 'items', `${record.id}.json`), record);
    itemHashes[record.id] = hash(record);
    shards[Number(record.id.slice(5)) % 100].push(record);
    if (record.active) catalog.push({id: record.id, active: true, title: record.info?.title, poster: record.info?.poster,
      providers: Object.keys(record.providers).filter(key => record.availability[key] === 'present'), enrichment: record.enrichment.status});
  }
  const origins = {...old.origins, ...Object.fromEntries(Object.entries(source.origins).flatMap(([provider, values]) =>
    Object.entries(values).map(([key,value]) => [`${provider}:${key}`, value])))};
  const shardHashes = {};
  shards.forEach((items,index) => {
    const name = String(index).padStart(2,'0');
    write(path.join(root, 'shards', `${name}.json`), items);
    shardHashes[name] = hash(items);
  });
  const manifest = {schemaVersion: 2, itemHashes, shardHashes, origins, catalogHash: hash(catalog), count: records.length,
    activeCount: catalog.length, inactiveCount: records.length-catalog.length,
    complete: Object.values(source.manifests).every(value => value.complete) && !conflicts.length && records.filter(value=>value.active).every(value => value.enrichment.status === 'ready' && !Object.values(value.availability).includes('unknown')),
    sourceSnapshots: Object.fromEntries(Object.entries(source.manifests).map(([key,value]) => [key, hash(value)])),
    conflicts, pendingCount: records.filter(value => value.active && value.enrichment.status !== 'ready').length};
  write(path.join(root, 'catalog.json'), catalog);
  write(path.join(root, 'registry.json'), registry);
  // All retained records remain synchronized; catalog membership is active-only.
  // Clients diff their own itemHashes against the latest manifest, even after months offline.
  write(path.join(root, 'changes.json'), {from: hash(old.itemHashes), to: hash(itemHashes),
    changed: Object.keys(itemHashes).filter(id => old.itemHashes[id] !== itemHashes[id]),
    deactivated: records.filter(value=>!value.active && previous.get(value.id)?.active !== false).map(value=>value.id),
    reactivated: records.filter(value=>value.active && previous.get(value.id)?.active === false).map(value=>value.id),
    removed: Object.keys(old.itemHashes).filter(id => !itemHashes[id])});
  manifest.coverageHash = require('../../shared/catalog/coverage').publish(root, records, 'anime');
  write(path.join(root, 'manifest.json'), manifest);
  return manifest;
}
module.exports = {ids, compatible, namespace, loadSources, groupEntries, baseRecord, publish};
