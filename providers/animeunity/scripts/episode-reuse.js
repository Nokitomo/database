'use strict';
const {matchesMapping,ENRICHMENT_SCHEMA_VERSION}=require('./incremental');
const {sourceFingerprint}=require('./source-fingerprint');
function episodeLifetime(e){return e.title&&!/^Episodes? \d/i.test(e.title)&&e.synopsis&&e.thumbnail?90:30;}
function episodeRefreshDue(final,now=Date.now()){
  return (final.episodes||[]).some(e=>{
    const checked=Date.parse(final.episodeCheckedAt?.[e.link]||'');
    return Number.isFinite(checked)&&now-checked>=episodeLifetime(e)*86400000;
  });
}
function reusableEpisodes(previous,raw,mapped,now=Date.now()){
  if(!previous||previous.enrichmentSchemaVersion!==ENRICHMENT_SCHEMA_VERSION||previous.episodeSafetyVersion!==1||
    !matchesMapping(previous,mapped)||previous.providerRef!==mapped.providerRef)return [];
  // A due service task may affect the interpretation of a complete season.
  if(Object.values(previous.metadataTasks||{}).some(t=>(t.kind==='episodes'||t.kind==='season-layout')&&
    (!Number.isFinite(t.nextCheckAt)||t.nextCheckAt<=now)))return [];
  const old=new Map((previous.sourceEpisodes||[]).map((e,i)=>[String(e.id),{e,i}]));
  const current=new Map(raw.episodes.map((e,i)=>[String(e.id),{e,i}]));
  return (previous.episodes||[]).filter(e=>{
    const a=old.get(String(e.link)),b=current.get(String(e.link));
    if(!a||!b||a.i!==b.i||sourceFingerprint({episodes:[a.e]})!==sourceFingerprint({episodes:[b.e]}))return false;
    const checked=Date.parse(previous.episodeCheckedAt?.[e.link]||previous.updatedAt||'');
    return Number.isFinite(checked)&&now-checked<episodeLifetime(e)*86400000;
  }).map(e=>structuredClone(e));
}
module.exports={reusableEpisodes,episodeRefreshDue};
