'use strict';
const {createContext,requireProvider}=require('../../providers/animeunity/scripts/vega');
const {meaningful}=require('./catalog');
const {explicitTarget,confirmedMatch}=require('./episode-identity');
const {needsEpisodeIdentity}=require('../../providers/animeunity/scripts/episode-safety');
const metrics=require('../../shared/metrics');
async function enrich(record,{providerRoot,cacheRoot,signal,progress={},save=()=>{},services={}}){
  const load=name=>services[name]||requireProvider(providerRoot,name),context=services.context||createContext(providerRoot,'https://source.invalid',null,{durableMetadata:true,componentCacheRoot:cacheRoot,signal});
  const out=structuredClone(record),tmdb=load('tmdb/index.js'),tvdb=load('tvdb/index.js');
  const checkpoint=async(key,fn)=>{signal?.throwIfAborted();if(!Object.hasOwn(progress,key)){
    const phase=key.startsWith('tmdb:')?'tmdbPhases':key.startsWith('tvdb:')?'tvdbPhases':'wikidataPhases';
    const result=await metrics.phase(phase,fn);
    if(Object.values(context.metadataTasks?.snapshot()||{}).some(t=>t.status==='error')||context.externalStatus?.tmdbWeb?.transientFailures>0)throw Error('External metadata request failed: '+key);
    progress[key]=result;save(progress);
  }else metrics.add('cache','checkpointHits');return progress[key];};
  const type=out.info.type==='movie'?'movie':'tv',tmdbId=Number(out.sourceIds.tmdb);
  let tvdbId=Number(out.sourceIds.tvdb);
  if(tmdbId&&(!out.sourceIds.imdb||!tvdbId)&&(providerRoot||services['wikidata/index.js'])){
    const ids=await checkpoint('wikidata:ids',()=>load('wikidata/index.js').resolveWikidataExternalIds({providerContext:context,tmdbId,type}));
    const conflict=ids&&((out.sourceIds.imdb&&ids.imdbId&&out.sourceIds.imdb!==ids.imdbId)||(tvdbId&&ids.tvdbId&&tvdbId!==Number(ids.tvdbId)));
    if(ids&&!conflict){out.externalIdsEvidence={wikidata:ids};out.sourceIds.imdb ||= ids.imdbId||null;out.sourceIds.tvdb ||= ids.tvdbId?String(ids.tvdbId):null;out.sourceIds.wikidata=ids.wikidataId;tvdbId=Number(out.sourceIds.tvdb);}
    else if(conflict)out.warnings.push({reason:'wikidata-external-id-conflict'});
  }
  const conflicts=new Set(out.warnings.filter(w=>w.season!==undefined).map(w=>w.season));
  if(tmdbId){const media=await checkpoint('tmdb:media',()=>tmdb.resolveTmdbMediaMetadata({providerContext:context,id:tmdbId,type}));
    out.info.synopsis ||= media?.overview?.value;out.externalMedia={tmdb:media};
    for(const field of ['year','runtime','rating','genres','cast'])if(out.info[field]==null||Array.isArray(out.info[field])&&!out.info[field].length)out.info[field]=media?.[field]?.value??media?.[field];
    out.artworkLibrary={tmdb:await checkpoint('tmdb:artwork',()=>load('tmdb/artworkLibrary.js').resolveTmdbArtworkLibrary({providerContext:context,id:tmdbId,type}))};
  }
  if(tvdbId&&!out.info.synopsis&&tvdb.resolveTvdbMediaTextMetadata){const media=await checkpoint('tvdb:media',()=>tvdb.resolveTvdbMediaTextMetadata({providerContext:context,tvdbId,mediaType:type==='tv'?'series':'movie'}));out.info.synopsis ||= media?.synopsis;out.externalMedia||={};out.externalMedia.tvdb=media;}
  if(tvdbId){out.artworkLibrary||={};out.artworkLibrary.tvdb=await checkpoint('tvdb:artwork',()=>load('tvdb/artworkLibrary.js').resolveTvdbArtworkLibrary({providerContext:context,tvdbId,mediaType:type==='tv'?'series':'movie',mappedSeasons:out.seasons.map(s=>s.number)}));}
  for(const season of out.seasons){
    if(out.episodeMappingUncertain||conflicts.has(season.number))continue;
    const eligible=season.episodes.filter(e=>!needsEpisodeIdentity(e.number));
    for(const service of ['tmdb','tvdb']){
      const id=service==='tmdb'?tmdbId:tvdbId;if(!id)continue;
      const gaps=eligible.filter(e=>!meaningful(e.title)||!e.synopsis||!e.thumbnail);
      // No external episode request when the provider already supplies everything.
      for(const e of gaps){
        e.metadataSources||={};e.externalMappings||={};
        const explicit=explicitTarget(out,season,e,service);
        if(!explicit&&!meaningful(e.title)){e.externalMappings[service]={status:'unverified',reason:'missing-distinctive-provider-title'};continue;}
        const targetSeason=explicit?.season??season.number;
        const data=await checkpoint(`${service}:identity-season:${targetSeason}${service==='tvdb'&&explicit?':'+explicit.episode:''}`,()=>service==='tmdb'
          ?tmdb.resolveTmdbEpisodeSeasonMetadata({providerContext:context,mediaId:id,seasonNumber:targetSeason,episodeNumbers:[]})
          :tvdb.resolveTvdbEpisodeFallbacks({providerContext:context,tvdbShowId:id,seasonNumber:targetSeason,episodeNumbers:season.episodes.filter(v=>!needsEpisodeIdentity(v.number)).map(v=>Number(v.number)).concat(explicit?[explicit.episode]:[])}));
        const rows=service==='tmdb'?(data?.episodes||[]):(data||[]);
        const m=explicit?rows.find(v=>Number(v.episodeNumber)===explicit.episode):confirmedMatch(e,season,rows,v=>service==='tmdb'?v.title?.value:v.title,v=>v.episodeNumber);
        if(!m){e.externalMappings[service]={status:'unverified',reason:'episode-identity-not-confirmed'};continue;}
        e.externalMappings[service]={status:'verified',id,season:targetSeason,episode:m.episodeNumber,method:explicit?.method||'unique-title-and-number'};
        const fields=service==='tmdb'?{title:m.title?.value,synopsis:m.overview?.value,thumbnail:m.thumbnail}:{title:m.title,synopsis:m.synopsis,thumbnail:m.thumbnail};
        e.metadataSources[service]=fields;
        for(const k of Object.keys(fields))if((k==='title'?!meaningful(e[k]):!e[k])&&fields[k]){e[k]=fields[k];out.provenance[`${season.number}:${e.number}:${k}`]=service;}
      }
    }
  }
  const tasks=context.metadataTasks?.snapshot()||{};out.metadataTasks=tasks;out.sourceStatus=context.externalStatus;
  const failed=Object.values(tasks).some(t=>t.status==='error')||context.externalStatus?.tmdbWeb?.transientFailures>0;
  const missing=out.seasons.some(s=>s.episodes.some(e=>!meaningful(e.title)||!e.synopsis||!e.thumbnail));
  out.enrichment={status:failed?'retry':!tmdbId&&!tvdbId?'unmapped':'ready',hasMissingEpisodeMetadata:missing};
  return out;
}
module.exports={enrich};
