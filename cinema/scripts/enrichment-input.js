'use strict';
const {hash}=require('../../shared/storage/json');
const {isCounter}=require('../../providers/streamingunity/scripts/card-fingerprint');
const noise=key=>isCounter(key)||key==='created_at'||key==='updated_at';
// Only provider info is normalized. Artwork ranking, episode order, release dates,
// playback coordinates and override evidence remain part of the contract.
function infoInput(value,key=''){
  if(Array.isArray(value)){
    const result=value.filter(v=>!(v&&typeof v==='object'&&isCounter(v.key))).map(v=>infoInput(v));
    return key==='main_actors'?result.sort((a,b)=>{const x=hash(a),y=hash(b);return x<y?-1:x>y?1:0;}):result;
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!noise(k)).map(([k,v])=>[k,infoInput(v,k)]));
  return value;
}
function input(base,entries,overrides){return {version:2,...(base.metadataPolicy?{metadataPolicy:base.metadataPolicy}:{}),episodeOverrides:Object.fromEntries(entries.map(e=>[e.key,overrides[e.key]||null])),ids:base.sourceIds,info:base.info,seasons:base.seasons,warnings:base.warnings};}
function semantic(value){return {...value,version:3,info:infoInput(value.info)};}
// Refresh only fields excluded from comparison. Never replace external fallbacks
// or verified overrides with the un-enriched provider info.
function refreshInfo(cached,current){
  const out=structuredClone(cached);
  for(const key of new Set([...Object.keys(out),...Object.keys(current)])){
    if(noise(key)||key==='main_actors'||key==='translations'){
      if(Object.hasOwn(current,key))out[key]=structuredClone(current[key]);else delete out[key];
    }else if(Array.isArray(out[key])&&Array.isArray(current[key])&&out[key].length===current[key].length){
      out[key]=out[key].map((v,i)=>v&&current[key][i]&&typeof v==='object'&&typeof current[key][i]==='object'?refreshInfo(v,current[key][i]):v);
    }else if(out[key]&&current[key]&&!Array.isArray(out[key])&&typeof out[key]==='object'&&typeof current[key]==='object')out[key]=refreshInfo(out[key],current[key]);
  }
  return out;
}
function legacyInput(old,group,overrides){
  const {mergeGroup}=require('./catalog');
  const {applyMetadataCorrections}=require('./metadata-corrections');
  const entries=[];
  for(const entry of group.entries){
    const variant=old.record.providers?.[entry.provider]?.find(v=>String(v.id)===String(entry.record.id));
    if(!variant)return null;
    const images=(old.record.images||[]).filter(v=>v.provider===entry.provider).map(({provider,...v})=>v);
    // Reconstruct the prior provider inputs, then prove the exact old hash.
    // Any missing field, changed policy or ambiguous reconstruction fails closed.
    entries.push({...entry,record:{...entry.record,info:variant.info,seasons:variant.seasons,images,
      path:variant.path,active:variant.availability==='present',
      sourceIds:{...entry.record.sourceIds,...Object.fromEntries(Object.entries(variant.info).filter(([k])=>k.endsWith('_id')))}}});
  }
  const prior=input(applyMetadataCorrections(mergeGroup({...group,entries})),entries,overrides);
  return hash(prior)===old.fingerprint?prior:null;
}
module.exports={input,semantic,infoInput,refreshInfo,legacyInput};
