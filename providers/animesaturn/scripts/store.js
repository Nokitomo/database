'use strict';
const path=require('node:path');
const {read,write,hash}=require('../../../shared/storage/json');
const DEFAULT_DATA=path.resolve(__dirname,'../data');
const itemFile=(root,id)=>{
  if (!/^[A-Za-z0-9]{5}$/.test(id)) throw new Error('Invalid AnimeSaturn ID');
  return path.join(root,'items',`${id}.json`);
};
function initialState(){return {schemaVersion:1,provider:'animesaturn',known:{},records:{},origins:{},archive:{},feed:{},errors:{}};}
function observe(state,card,now){
  const prior=state.known[card.id];
  const signature=hash({path:card.path,title:card.title,type:card.type,poster:card.poster,subtitle:card.subtitle,episodeLabel:card.episodeLabel});
  // Archive and update feed signatures are independent.
  const source=card.episodeLabel==null?'archive':'feed';
  state.known[card.id]={...prior,...card,active:true,lastSeenAt:now,missingScans:0,
    signatures:{...prior?.signatures,[source]:signature},
    refresh:Boolean(prior?.refresh || prior && (!prior.active || prior.signatures?.[source] && prior.signatures[source]!==signature))};
}
function publish(root,state,status){
  const records=Object.values(state.known).filter(value=>value.active).map(value=>read(itemFile(root,value.id))).filter(Boolean).sort((a,b)=>a.id.localeCompare(b.id));
  for(const record of records){
    record.images=[...new Map([...(record.images||[]),...(state.homeImages?.[record.id]||[])].map(value=>[hash(value),value])).values()];
    write(itemFile(root,record.id),record);
  }
  const catalog=records.map(value=>({id:value.id,path:value.path,title:value.info.title,poster:value.info.poster,status:value.info.status,
    sourceIds:value.sourceIds,episodeCount:value.episodes.length}));
  const groups=Array.from({length:100},()=>[]),shardHashes={};
  for(const record of records) groups[parseInt(hash(record.id).slice(0,8),16)%100].push(record);
  groups.forEach((items,index)=>{const key=String(index).padStart(2,'0');write(path.join(root,'shards',key+'.json'),items);shardHashes[key]=hash(items);});
  write(path.join(root,'catalog.json'),catalog);
  const manifest={schemaVersion:1,provider:'animesaturn',origins:state.origins,discovery:state.discovery,
    archiveTotal:state.archive.total||null,archiveCheckedAt:state.archive.completedAt||null,
    expectedCount:Object.values(state.known).filter(value=>value.active).length,availableCount:records.length,
    ...status,errors:state.errors,recordErrors:Object.fromEntries(Object.entries(state.records).filter(([,value])=>value.error).map(([id,value])=>[id,value.error])),
    inactiveIds:Object.values(state.known).filter(value=>!value.active).map(value=>value.id),
    catalogHash:hash(catalog),shardHashes,itemHashes:Object.fromEntries(records.map(value=>[value.id,hash(value)]))};
  write(path.join(root,'manifest.json'),manifest);return manifest;
}
module.exports={DEFAULT_DATA,itemFile,read,write,hash,initialState,observe,publish};
