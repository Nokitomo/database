'use strict';
const path=require('node:path');
const {DEFAULT_DATA,read,hash,itemFile}=require('./store');
function verify(root=DEFAULT_DATA){
  const manifest=read(path.join(root,'manifest.json')),catalog=read(path.join(root,'catalog.json'));
  if(!manifest||!catalog||hash(catalog)!==manifest.catalogHash)throw new Error('Invalid AnimeSaturn catalog');
  const seen=new Set();
  const walk=value=>{
    if(!value||typeof value!=='object')return;
    if(value.base&&(!manifest.origins[value.base]||!/^\/(?!\/)/.test(value.path)))throw new Error('Invalid image reference');
    Object.values(value).forEach(walk);
  };
  for(const row of catalog){
    const record=read(itemFile(root,row.id));
    if(!record||record.provider!=='animesaturn'||record.id!==row.id||seen.has(row.id)||hash(record)!==manifest.itemHashes[row.id])throw new Error('Invalid AnimeSaturn item');
    seen.add(row.id);
    if(!record.info.title||record.episodes.length!==record.info.availableEpisodeCount||new Set(record.episodes.map(value=>value.id)).size!==record.episodes.length)throw new Error('Invalid episode inventory');
    walk(record);
  }
  const shardIds=new Set();
  for(const [name,expected]of Object.entries(manifest.shardHashes)){
    const records=read(path.join(root,'shards',name+'.json'));
    if(!records||hash(records)!==expected)throw new Error('Invalid shard');
    for(const record of records){if(shardIds.has(record.id)||!seen.has(record.id)||hash(record)!==manifest.itemHashes[record.id])throw new Error('Invalid shard item');shardIds.add(record.id);}
  }
  if(seen.size!==manifest.availableCount||seen.size!==Object.keys(manifest.itemHashes).length||shardIds.size!==seen.size)throw new Error('Invalid manifest counts');
  return {count:seen.size,complete:manifest.complete};
}
if(require.main===module)console.log(verify());
module.exports={verify};
