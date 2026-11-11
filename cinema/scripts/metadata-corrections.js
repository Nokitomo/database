'use strict';
const {explicitTarget}=require('./episode-identity');
// Apply after assembling sources: preserve their original metadata and playback IDs.
function applyMetadataCorrections(record){
  const title=record.metadataPolicy?.displayTitle;
  if(title){record.info.name=title;record.info.title=title;}
  for(const season of record.seasons)for(const episode of season.episodes){
    const target=explicitTarget(record,season,episode,'tmdb');
    if(!target?.replacement)continue;
    const fields=target.replacement;
    if(typeof fields.title!=='string'||!fields.title.trim()||typeof fields.synopsis!=='string'||!fields.synopsis.trim()||!(fields.thumbnail===undefined||fields.thumbnail===null||typeof fields.thumbnail==='string'))throw Error('Invalid verified episode metadata');
    episode.metadataSources||={};
    episode.metadataSources.verifiedOverride={...fields,evidence:target.evidence};
    for(const key of ['title','synopsis','thumbnail']){
      if(!Object.hasOwn(fields,key))continue;
      episode[key]=fields[key];
      record.provenance[`${season.number}:${episode.number}:${key}`]='verified-override';
    }
    if(target.streamObservation)episode.streamObservation=structuredClone(target.streamObservation);
  }
  return record;
}
module.exports={applyMetadataCorrections};
