'use strict';
const path=require('node:path');
const {cardFingerprint,activityCounters}=require('./card-fingerprint');
const {read,write,hash}=require('../../../shared/storage/json');
const DEFAULT_DATA=path.resolve(__dirname,'../data');
function itemFile(root,id){if(!/^\d+$/.test(String(id))||Number(id)<=0)throw new Error('Invalid ID');return path.join(root,'items',id+'.json');}
function initialState(){return {schemaVersion:1,provider:'streamingunity',known:{},records:{},origins:{},errors:{},archive:{},feeds:{}};}
function observe(state,card,now){const old=state.known[card.id];const fingerprint=cardFingerprint(card);
  // Old state stores only an opaque hash: migrate exact matches without work;
  // otherwise refresh once rather than discard a potentially real change.
  const changed=old&&(old.fingerprintVersion===2?old.fingerprint!==fingerprint:old.fingerprint!==hash(card));
  state.known[card.id]={...old,id:card.id,path:require('./urls').titlePath(card.id,card.slug),active:true,missingScans:0,
    lastSeenAt:now,fingerprint,fingerprintVersion:2,activityCounters:activityCounters(card),refresh:!!(old?.refresh||old&&(!old.active||changed))};
  delete state.known[card.id].notFound;
  if(old&&!old.active&&old.retirement)state.known[card.id].reactivatedAt=now;
}
function publish(root,state,status){
  const records=Object.values(state.known).map(k=>{const r=read(itemFile(root,k.id));if(!r)return null;r.active=k.active;write(itemFile(root,k.id),r);return r;}).filter(Boolean).sort((a,b)=>a.id-b.id);
  const old=read(path.join(root,'manifest.json'),{itemHashes:{}}),itemHashes=Object.fromEntries(records.map(r=>[r.id,hash(r)]));
  const catalog=records.filter(r=>r.active).map(r=>({id:r.id,path:r.path,title:r.info.name,type:r.info.type,images:r.images,sourceIds:r.sourceIds}));
  const shards=Array.from({length:100},()=>[]),shardHashes={};records.forEach(r=>shards[r.id%100].push(r));
  shards.forEach((items,i)=>{const key=String(i).padStart(2,'0');write(path.join(root,'shards',key+'.json'),items);shardHashes[key]=hash(items);});
  write(path.join(root,'catalog.json'),catalog);
  const manifest={schemaVersion:1,provider:'streamingunity',locale:'it',origins:state.origins,discovery:state.discovery,
    archive:state.archive.completedAt?{checkedAt:state.archive.completedAt,total:state.archive.total}:null,
    expectedCount:Object.values(state.known).filter(k=>k.active).length,availableCount:catalog.length,count:records.length,
    inactiveIds:Object.values(state.known).filter(k=>!k.active).map(k=>k.id),itemHashes,shardHashes,catalogHash:hash(catalog),errors:state.errors,...status};
  write(path.join(root,'changes.json'),{changed:Object.keys(itemHashes).filter(id=>old.itemHashes[id]!==itemHashes[id]),removed:[]});
  write(path.join(root,'manifest.json'),manifest);return manifest;
}
module.exports={read,write,hash,DEFAULT_DATA,itemFile,initialState,observe,publish};
