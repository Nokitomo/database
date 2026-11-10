"use strict";
const {meaningful}=require('./catalog');
const overrides=require('../episode-overrides.json');
const normalize=v=>String(v||'').normalize('NFKC').toLocaleLowerCase('it').replace(/[^\p{L}\p{N}]/gu,'');
function explicitTarget(record,season,episode,service){
  for(const [provider,variants] of Object.entries(record.providers||{}))for(const variant of variants){
    const rule=overrides[`${provider}:${variant.id}`]?.[service];
    if(!rule||String(rule.id)!==String(service==='tmdb'?(record.metadataPolicy?.tmdb?.id??record.sourceIds.tmdb):record.sourceIds[service]))continue;
    const target=rule.episodes?.[`${season.number}:${episode.number}`];
    if(!target)continue;
    if(!target.evidence||!target.sourceTitle||normalize(target.sourceTitle)!==normalize(episode.title)||!Number.isInteger(target.season)||target.season<0||!Number.isInteger(target.episode)||target.episode<0)throw Error('Invalid or stale cinema episode override');
    return {...target,method:'verified-override'};
  }
  return null;
}
function confirmedMatch(episode,season,rows,titleOf,numberOf){
  // Number alone and translated/fuzzy titles are not identity evidence.
  if(!meaningful(episode.title))return null;
  const title=normalize(episode.title);if(!title)return null;
  if(season.episodes.filter(e=>normalize(e.title)===title).length!==1)return null;
  const matches=rows.filter(row=>meaningful(titleOf(row))&&normalize(titleOf(row))===title);
  if(matches.length!==1||String(numberOf(matches[0]))!==String(episode.number))return null;
  return matches[0];
}
module.exports={explicitTarget,confirmedMatch};
