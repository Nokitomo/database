'use strict';
const path = require('node:path');
const {read, hash} = require('../../providers/animeworld/scripts/store');
function verify(root) {
  const manifest = read(path.join(root, 'manifest.json'));
  const catalog = read(path.join(root, 'catalog.json'));
  if (!manifest || !catalog || hash(catalog) !== manifest.catalogHash) throw new Error('Invalid catalog');
  const seen = new Set();
  for (const row of catalog) {
    if (!/^work-\d+$/.test(row.id) || seen.has(row.id)) throw new Error('Invalid canonical identity');
    seen.add(row.id);
    const record = read(path.join(root, 'items', `${row.id}.json`));
    if (record?.id !== row.id || hash(record) !== manifest.itemHashes[row.id]) throw new Error(`Invalid item ${row.id}`);
    if (!Object.values(record.providers).some(entries => entries.length)) throw new Error('Item without a provider');
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.base && value.path && !manifest.origins[value.base]) throw new Error(`Unknown origin ${value.base}`);
      Object.values(value).forEach(walk);
    };
    walk(record);
  }
  if (seen.size !== Object.keys(manifest.itemHashes).length || seen.size !== manifest.count) throw new Error('Invalid manifest count');
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
