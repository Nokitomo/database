'use strict';
const path=require('node:path');
const {read,write,hash}=require('../storage/json');
const policy=require('./coverage');
const DAY=86400000;
function configure(client,provider,root,state,now){
  if(client.coverage===undefined)client.coverage=policy.load(provider,undefined,now);
  const revision=client.coverage?.contentHash||null;
  if(state.coverageRevision===revision)return;
  for(const k of Object.values(state.known)){
    if(!k.active)continue;
    const r=read(path.join(root,'items',k.id+'.json'));
    if(r?.collection?.mode==='linked'&&policy.decide(client.coverage,r).mode!=='linked'){
      if(provider==='animeworld')k.forceRefresh=true;else k.refresh=true;
      if(state.records[k.id])state.records[k.id].nextCheckAt=0;
    }
  }
  state.coverageRevision=revision;
}
function reuse(client,state,root,id,now,save=()=>{}){
  const k=state.known[id],r=read(path.join(root,'items',id+'.json'));
  if(r?.metadataComplete===false||state.records[id]?.complete===false||state.records[id]?.error||state.errors['item:'+id])return null;
  const fullSince=state.fullSince||state.full?.since;
  if(fullSince&&(!r?.collection?.identityCheckedAt||r.collection.identityCheckedAt<fullSince))return null;
  if(!policy.reusable(r,k,client.coverage,now))return null;
  r.collection={...r.collection,...policy.decide(client.coverage,r)};
  const meta=state.records[id]||={};
  Object.assign(meta,{complete:true,checkedAt:now,pageAt:now,tooltipAt:now,
    nextCheckAt:Math.min(now+DAY,r.collection.identityCheckedAt+7*DAY),missingScans:0});
  delete meta.error;delete state.errors['item:'+id];
  write(path.join(root,'items',id+'.json'),r);save();return r;
}
function annotate(record,client,now,previous,changed=false){
  let result=policy.annotate(record,client.coverage,now,previous);
  if(changed&&client.coverage&&!(client.coverage.kind==='anime'&&result.mode==='linked')){result={mode:'full',reason:'provider-reported-change'};record.collection=result;}
  if(result.mode==='linked'&&previous){
    // Keep already acquired metadata even when this collection omits extra calls.
    for(const [key,value]of Object.entries(previous.info||{}))if(record.info[key]==null||record.info[key]===''||Array.isArray(record.info[key])&&!record.info[key].length)record.info[key]=value;
    record.images=[...new Map([...(previous.images||[]),...(record.images||[])].map(i=>[hash(i),i])).values()];
    for(const key of ['tooltip','sourceMetadata','playback'])if(record[key]==null&&previous[key]!=null)record[key]=previous[key];
    const old=new Map((previous.episodes||[]).map(e=>[String(e.id),e]));
    if(record.episodes)record.episodes=record.episodes.map(e=>{const before=old.get(String(e.id));if(!before||before.number!==e.number||before.path&&e.path&&before.path!==e.path)return e;const merged={...before,...e};for(const [k,v]of Object.entries(before))if(merged[k]==null)merged[k]=v;return merged;});
  }
  return result;
}
module.exports={configure,reuse,annotate};
