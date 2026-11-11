'use strict';
const path=require('node:path'),{read,hash}=require('../../shared/storage/json');
function verify(root=path.resolve(__dirname,'../data'),{onRecord}={}){
  const m=read(path.join(root,'manifest.json')),catalog=read(path.join(root,'catalog.json'));
  if(!m||m.kind!=='cinema'||hash(catalog)!==m.catalogHash||catalog.length!==m.activeCount)throw Error('Invalid cinema manifest');
  require('../../shared/catalog/coverage').verifyPublication(root,m.coverageHash,'cinema');
  if(m.reviewHash&&hash(read(path.join(root,'identity-review.json')))!==m.reviewHash)throw Error('Invalid identity review');
  const membership=new Set(),registry=read(path.join(root,'registry.json'));
  const active=new Set(catalog.map(x=>x.id));if(active.size!==catalog.length||Object.keys(m.itemHashes).length!==m.count)throw Error('Invalid counts');
  function walk(v){if(!v||typeof v!=='object')return;if(v.base&&v.path&&!m.origins[v.base])throw Error('Unknown origin');Object.values(v).forEach(walk);}
  for(const [id,expected]of Object.entries(m.itemHashes)){const r=read(path.join(root,'items',id+'.json'));if(!r||r.id!==id||hash(r)!==expected||r.active!==active.has(id))throw Error('Invalid cinema item');walk(r);require('./composition').verifyComposition(r);if(m.identityPolicyVersion>=2)for(const [provider,variants]of Object.entries(r.providers))for(const v of variants){if(v.availability==='reassigned')continue;const key=provider+':'+v.id;if(registry.members[key]!==id)throw Error('Incorrect source owner '+key);if(membership.has(key))throw Error('Duplicate source membership '+key);membership.add(key);}onRecord?.(r);}
  const seen=new Set();for(const [key,expected]of Object.entries(m.shardHashes)){const rows=read(path.join(root,'shards',key+'.json'));if(hash(rows)!==expected)throw Error('Invalid cinema shard');for(const r of rows){if(seen.has(r.id)||m.itemHashes[r.id]!==hash(r))throw Error('Invalid shard membership');seen.add(r.id);}}
  if(seen.size!==m.count)throw Error('Missing shard items');
  if(m.complete&&(m.pendingCount||(m.identityPolicyVersion>=2?m.conflicts.some(c=>c.blocking!==false):m.conflicts.length)||!Object.values(m.sources).every(s=>s.complete)))throw Error('Invalid completion');return {count:m.count,complete:m.complete};
}
if(require.main===module)console.log(verify());module.exports={verify};
