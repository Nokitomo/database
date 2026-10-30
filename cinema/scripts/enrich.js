'use strict';
const {createContext,requireProvider}=require('../../scripts/vega');
const {meaningful}=require('./catalog');
const {needsEpisodeIdentity}=require('../../scripts/episode-safety');
async function enrich(record,{providerRoot,cacheRoot,signal,progress={},save=()=>{},services={}}){
  const load=name=>services[name]||requireProvider(providerRoot,name),context=services.context||createContext(providerRoot,'https://source.invalid',null,{durableMetadata:true,componentCacheRoot:cacheRoot,signal});
  const out=structuredClone(record),tmdb=load('tmdb/index.js'),tvdb=load('tvdb/index.js');
  const checkpoint=async(key,fn)=>{signal?.throwIfAborted();if(!Object.hasOwn(progress,key)){
    const result=await fn();
    if(Object.values(context.metadataTasks?.snapshot()||{}).some(t=>t.status==='error')||context.externalStatus?.tmdbWeb?.transientFailures>0)throw Error('External metadata request failed: '+key);
    progress[key]=result;save(progress);
  }return progress[key];};
  const type=out.info.type==='movie'?'movie':'tv',tmdbId=Number(out.sourceIds.tmdb),tvdbId=Number(out.sourceIds.tvdb);
  const conflicts=new Set(out.warnings.filter(w=>w.season!==undefined).map(w=>w.season));
  if(tmdbId){const media=await checkpoint('tmdb:media',()=>tmdb.resolveTmdbMediaMetadata({providerContext:context,id:tmdbId,type}));
    out.info.synopsis ||= media?.overview?.value;out.externalMedia={tmdb:media};
    for(const field of ['year','runtime','rating','genres','cast'])if(out.info[field]==null||Array.isArray(out.info[field])&&!out.info[field].length)out.info[field]=media?.[field]?.value??media?.[field];
    out.artworkLibrary={tmdb:await checkpoint('tmdb:artwork',()=>load('tmdb/artworkLibrary.js').resolveTmdbArtworkLibrary({providerContext:context,id:tmdbId,type}))};
  }
  if(tvdbId){out.artworkLibrary||={};out.artworkLibrary.tvdb=await checkpoint('tvdb:artwork',()=>load('tvdb/artworkLibrary.js').resolveTvdbArtworkLibrary({providerContext:context,tvdbId,mediaType:type==='tv'?'series':'movie',mappedSeasons:out.seasons.map(s=>s.number)}));}
  for(const season of out.seasons){
    // Conflicting inventories are retained per provider, never guessed against TMDB.
    if(out.episodeMappingUncertain||conflicts.has(season.number))continue;
    const eligible=season.episodes.filter(e=>!needsEpisodeIdentity(e.number));
    const missing=eligible.filter(e=>!meaningful(e.title)||!e.synopsis||!e.thumbnail);
    if(tmdbId&&missing.length){const data=await checkpoint('tmdb:season:'+season.number,()=>tmdb.resolveTmdbEpisodeSeasonMetadata({providerContext:context,mediaId:tmdbId,seasonNumber:season.number,episodeNumbers:missing.map(e=>Number(e.number))}));
      for(const e of missing){const m=data?.episodes?.find(v=>v.episodeNumber===Number(e.number));if(!m)continue;
        const fields={title:m.title?.value,synopsis:m.overview?.value,thumbnail:m.thumbnail};e.metadataSources.tmdb=fields;
        for(const k of Object.keys(fields))if((k==='title'?!meaningful(e[k]):!e[k])&&fields[k]){e[k]=fields[k];out.provenance[`${season.number}:${e.number}:${k}`]='tmdb';}
      }
    }
    const gaps=eligible.filter(e=>!meaningful(e.title)||!e.synopsis||!e.thumbnail);
    if(tvdbId&&gaps.length){const rows=await checkpoint('tvdb:season:'+season.number,()=>tvdb.resolveTvdbEpisodeFallbacks({providerContext:context,tvdbShowId:tvdbId,seasonNumber:season.number,episodeNumbers:gaps.map(e=>Number(e.number))}));
      for(const e of gaps){const m=rows?.find(v=>v.episodeNumber===Number(e.number));if(!m)continue;
        e.metadataSources.tvdb=m;for(const k of ['title','synopsis','thumbnail'])if((k==='title'?!meaningful(e[k]):!e[k])&&m[k]){e[k]=m[k];out.provenance[`${season.number}:${e.number}:${k}`]='tvdb';}
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
