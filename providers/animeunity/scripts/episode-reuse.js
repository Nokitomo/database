'use strict';
const {matchesMapping,componentDependencies,canonical,ENRICHMENT_SCHEMA_VERSION}=require('./incremental');
const {sourceFingerprint}=require('./source-fingerprint');
function episodeLifetime(e){return e.title&&!/^Episodes? \d/i.test(e.title)&&e.synopsis&&e.thumbnail?90:30;}
function episodeRefreshDue(final,now=Date.now()){
  return (final.episodes||[]).some(e=>{
    const checked=Date.parse(final.episodeCheckedAt?.[e.link]||'');
    return Number.isFinite(checked)&&now-checked>=episodeLifetime(e)*86400000;
  });
}
function reusableEpisodes(previous,raw,mapped,now=Date.now(),resolveEpisode){
  const sameMapping = matchesMapping(previous,mapped);
  const components = componentDependencies(mapped);
  const sameEpisodes = sameMapping || previous?.componentDependencies?.episodes === components.episodes;
  const comparable = resolveEpisode && previous?.componentDependencies?.episodeIdentity === components.episodeIdentity;
  if(!previous||previous.enrichmentSchemaVersion!==ENRICHMENT_SCHEMA_VERSION||previous.episodeSafetyVersion!==1||
    (!sameEpisodes&&!comparable)||previous.providerRef!==mapped.providerRef)return [];
  // A due service task may affect the interpretation of a complete season.
  if(Object.values(previous.metadataTasks||{}).some(t=>(t.kind==='episodes'||t.kind==='season-layout')&&
    (!Number.isFinite(t.nextCheckAt)||t.nextCheckAt<=now)))return [];
  const old=new Map((previous.sourceEpisodes||[]).map((e,i)=>[String(e.id),{e,i}]));
  const current=new Map(raw.episodes.map((e,i)=>[String(e.id),{e,i}]));
  return (previous.episodes||[]).filter(e=>{
    const a=old.get(String(e.link)),b=current.get(String(e.link));
    if(!a||!b||a.i!==b.i||sourceFingerprint({episodes:[a.e]})!==sourceFingerprint({episodes:[b.e]}))return false;
    if(!sameEpisodes){
      const number=Number(b.e.number);
      if(!Number.isInteger(number)||number<=0||!Array.isArray(e.externalMappings))return false;
      // Record-aligned groups can renumber source episodes. Reuse only when
      // the ordinary resolver reproduces the saved correspondence exactly.
      const preferred=e.externalMappings.find(m=>m.provider==='tmdb_show');
      const normalize=value=>JSON.stringify(canonical(value));
      const resolution=value=>({targets:(value.mappings?.targets||[]).map(t=>({...t,ranges:t.ranges||{}}))});
      const before=resolveEpisode(resolution(previous),number,preferred);
      const after=resolveEpisode(resolution(mapped),number,preferred);
      if(normalize(before)!==normalize(after)||normalize(before.mappings)!==normalize(e.externalMappings)||
        before.seasonNumber!==e.seasonNumber)return false;
    }
    const checked=Date.parse(previous.episodeCheckedAt?.[e.link]||previous.updatedAt||'');
    return Number.isFinite(checked)&&now-checked<episodeLifetime(e)*86400000;
  }).map(e=>structuredClone(e));
}
module.exports={reusableEpisodes,episodeRefreshDue};
