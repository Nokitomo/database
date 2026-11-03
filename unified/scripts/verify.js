'use strict';
const path = require('node:path');
const {read, hash} = require('../../providers/animeworld/scripts/store');
function verify(root) {
  const manifest = read(path.join(root, 'manifest.json'));
  const catalog = read(path.join(root, 'catalog.json'));
  if (!manifest || !catalog || hash(catalog) !== manifest.catalogHash) throw new Error('Invalid catalog');
  require('../../shared/catalog/coverage').verifyPublication(root,manifest.coverageHash,'anime');
  const seen = new Set();
  let activeCount = 0;
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported lifecycle schema');
  const activeIds = new Set(catalog.map(row=>row.id));
  if (activeIds.size !== catalog.length) throw new Error('Duplicate catalog identity');
  for (const row of Object.keys(manifest.itemHashes).map(id=>({id}))) {
    if (!/^work-\d+$/.test(row.id) || seen.has(row.id)) throw new Error('Invalid canonical identity');
    seen.add(row.id);
    const record = read(path.join(root, 'items', `${row.id}.json`));
    if (record?.id !== row.id || hash(record) !== manifest.itemHashes[row.id]) throw new Error(`Invalid item ${row.id}`);
    if (!record.info?.title) throw new Error(`Missing title for ${row.id}`);
    if (!Object.values(record.providers).some(entries => entries.length)) throw new Error('Item without a provider');
    if (typeof record.active !== 'boolean' || activeIds.has(row.id) !== (record.active && !record.displayWorkId)) throw new Error('Invalid active membership');
    if (record.active) activeCount++;
    for (const [provider, variants] of Object.entries(record.providers)) {
      if (variants.some(value=>!['present','unavailable','unknown','reassigned'].includes(value.availability))) throw new Error('Invalid provider availability');
      const expected = variants.some(v=>v.availability==='present') ? 'present' : variants.some(v=>v.availability==='unknown') ? 'unknown' : variants.length ? 'unavailable' : 'not_matched';
      if (record.availability[provider] !== expected) throw new Error('Inconsistent availability');
    }
    if (record.active !== Object.values(record.availability).some(value=>['present','unknown'].includes(value))) throw new Error('Inconsistent active flag');
    if (record.displayWorkId) {
      const target = read(path.join(root,'items',`${record.displayWorkId}.json`));
      if (!record.active || record.displayWorkId === record.id || !target?.active || target.displayWorkId)
        throw new Error('Invalid display work');
    }
    for (const route of record.episodeStreamSources || []) {
      if (!manifest.itemHashes[route.sourceWorkId] || !/^(animeunity|animeworld|animesaturn|animetop)$/.test(route.provider) ||
          !/^\d+(?:\.\d+)?$/.test(route.episodeNumber)) throw new Error('Invalid episode stream source');
      const source = read(path.join(root,'items',`${route.sourceWorkId}.json`));
      const variant = source?.providers?.[route.provider]?.find(value => String(value.id) === route.providerId);
      if (source?.displayWorkId !== record.id || !variant ||
          !variant.episodes?.some(episode => String(episode.number) === route.sourceEpisodeNumber &&
            (route.sourceEpisodeId == null || episode.id === route.sourceEpisodeId)))
        throw new Error('Broken episode stream source');
    }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.base && value.path && !manifest.origins[value.base]) throw new Error(`Unknown origin ${value.base}`);
      Object.values(value).forEach(walk);
    };
    walk(record);
  }
  if (seen.size !== Object.keys(manifest.itemHashes).length || seen.size !== manifest.count) throw new Error('Invalid manifest count');
  if (catalog.some(row=>!seen.has(row.id) || row.active !== true) || manifest.activeCount !== activeCount ||
      (manifest.catalogCount ?? manifest.activeCount) !== catalog.length || manifest.inactiveCount !== seen.size-activeCount) throw new Error('Invalid lifecycle counts');
  const shardIds = new Set();
  for (const [name, expected] of Object.entries(manifest.shardHashes)) {
    const items = read(path.join(root, 'shards', `${name}.json`));
    if (!items || hash(items) !== expected) throw new Error('Invalid shard');
    for (const item of items) {
      if (shardIds.has(item.id) || !seen.has(item.id) || hash(item) !== manifest.itemHashes[item.id]) throw new Error('Invalid shard membership');
      shardIds.add(item.id);
    }
  }
  if (shardIds.size !== seen.size) throw new Error('Incomplete shards');
  return {count: seen.size};
}
if (require.main === module) console.log(verify(path.resolve(__dirname, '../data')));
module.exports = {verify};
