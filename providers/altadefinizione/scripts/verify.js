'use strict';
const path=require('node:path');
const {read,hash,DEFAULT_DATA,itemFile}=require('./store');
function verify(root=DEFAULT_DATA){
  const m=read(path.join(root,'manifest.json')),catalog=read(path.join(root,'catalog.json'));
  if(!m||m.provider!=='altadefinizione'||m.locale!=='it'||!catalog||hash(catalog)!==m.catalogHash)throw new Error('Invalid manifest/catalog');
  const active=new Set(catalog.map(r=>r.id));if(active.size!==catalog.length||catalog.length!==m.availableCount)throw new Error('Invalid catalog count');
  const ids=new Set(Object.keys(m.itemHashes));if(ids.size!==m.count)throw new Error('Invalid count');
  function walk(v){if(!v||typeof v!=='object')return;if(v.base&&v.path&&!m.origins[v.base])throw new Error('Unknown image origin');Object.values(v).forEach(walk);}
  for(const id of ids){const r=read(itemFile(root,id));if(!r||String(r.id)!==id||hash(r)!==m.itemHashes[id]||!r.info?.name||typeof r.active!=='boolean'||r.active!==active.has(r.id)||!/^\/[^/]+\/\d+-[^/]+\.html$/.test(r.path)||!Array.isArray(r.seasons))throw new Error('Invalid record '+id);
    if(r.seasons.length!==r.seasonIndex.length||r.seasons.some(s=>!r.seasonIndex.some(v=>v.number===s.number&&v.id===s.id)))throw new Error('Invalid season membership');walk(r);}
  const seen=new Set();for(const [key,expected]of Object.entries(m.shardHashes)){const rows=read(path.join(root,'shards',key+'.json'));if(!rows||hash(rows)!==expected)throw new Error('Invalid shard');for(const r of rows){if(seen.has(r.id)||m.itemHashes[r.id]!==hash(r))throw new Error('Invalid shard item');seen.add(r.id);}}
  if(seen.size!==ids.size)throw new Error('Incomplete shards');
  if(m.complete&&(m.expectedCount!==m.availableCount||!m.archive||Object.keys(m.errors).length))throw new Error('Invalid completion');
  return {count:ids.size,active:active.size,complete:m.complete};
}
if(require.main===module)console.log(verify());module.exports={verify};
