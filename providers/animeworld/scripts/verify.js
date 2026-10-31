'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const {DEFAULT_DATA, read, hash, activeIds, itemFile} = require('./store');
const {resolveReference} = require('./urls');

function checkReferences(value, origins) {
  if (typeof value === 'string') assert.ok(!/^https?:\/\/(?:[\w-]+\.)?animeworld\.[a-z]+(?:\/|$)/i.test(value),
    'Hardcoded AnimeWorld URL in a record');
  if (!value || typeof value !== 'object') return;
  if (value.base && value.path) assert.ok(/^https:\/\//.test(resolveReference(value, origins)));
  for (const child of Object.values(value)) checkReferences(child, origins);
}

function verify(root = DEFAULT_DATA) {
  const state = read(path.join(root,'state.json')), manifest = read(path.join(root,'manifest.json'));
  assert.equal(state?.provider,'animeworld'); assert.equal(manifest?.schemaVersion,1);
  const ids = activeIds(state), present = [];
  assert.equal(manifest.expectedCount,ids.length);
  for (const id of ids) {
    const record = read(itemFile(root,id));
    if (!record) {assert.ok(!state.records[id]?.pageAt);continue;}
    assert.equal(record.id,id); assert.equal(record.code,state.known[id].code);
    assert.ok(record.info.title); assert.ok(/^\/play\//.test(record.path));
    assert.equal(record.info.availableEpisodeCount,record.episodes.length);
    assert.equal(new Set(record.episodes.map(episode=>episode.id)).size,record.episodes.length);
    assert.equal(manifest.itemHashes[id],hash(record));
    checkReferences(record,manifest.origins);
    present.push(id);
    if (manifest.complete) {
      assert.ok(state.records[id]?.pageAt && state.records[id]?.tooltipAt && (record.tooltip || record.collection?.mode==='linked'));
      assert.ok(!state.records[id].error);
    }
  }
  assert.equal(manifest.availableCount,present.length);
  assert.deepEqual(Object.keys(manifest.itemHashes).map(Number).sort((a,b)=>a-b),present);
  const catalog = read(path.join(root,'catalog.json'));
  assert.deepEqual(catalog.map(card=>card.id),present); assert.equal(manifest.catalogHash,hash(catalog));
  const fromShards = [];
  for (let i=0;i<100;i++) {
    const key=String(i).padStart(2,'0'),shard=read(path.join(root,'shards',key+'.json'));
    assert.equal(manifest.shardHashes[key],hash(shard));
    for (const record of shard) {
      assert.equal(record.id%100,i); assert.equal(hash(record),manifest.itemHashes[record.id]);fromShards.push(record.id);
    }
  }
  assert.deepEqual(fromShards.sort((a,b)=>a-b),present);
  if (manifest.complete) {
    assert.equal(present.length,ids.length); assert.ok(state.archive.completedAt && !state.archive.scan);
    assert.equal(Object.keys(state.errors).length,0); assert.equal(manifest.pendingCount,0);
  }
  const archive = read(path.join(root,'archive.json'));
  if (archive) {
    assert.equal(archive.total,archive.items.length);
    assert.equal(new Set(archive.items.map(item=>item.id)).size,archive.total);
    assert.equal(archive.checkedAt,state.archive.completedAt);
  }
  // Retired records are intentionally left in items/, but never exported.
  for (const id of manifest.inactiveIds) assert.ok(!present.includes(id));
  return {expected:ids.length,available:present.length,complete:manifest.complete};
}
if (require.main === module) {
  const args=process.argv.slice(2);
  if (args.length && (args[0]!=='--data-dir'||args.length!==2)) throw new Error('Use --data-dir PATH');
  console.log(verify(args.length?path.resolve(args[1]):DEFAULT_DATA));
}
module.exports={verify,checkReferences};
