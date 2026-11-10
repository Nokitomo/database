'use strict';
const {createContext,requireProvider}=require('../../providers/animeunity/scripts/vega');
const {meaningful}=require('./catalog');
const {explicitTarget,confirmedMatch}=require('./episode-identity');
const {needsEpisodeIdentity}=require('../../providers/animeunity/scripts/episode-safety');
const metrics=require('../../shared/metrics');
const {createTmdbAdapter,mediaFields}=require('./tmdb-adapter');
function retainAvailable(old,value){
  if(value==null||value?.status==='unavailable')return old??value;
  if(value?.status)return value;
  if(typeof value!=='object'||Array.isArray(value))return value;
  const result={...old};for(const [key,next]of Object.entries(value))result[key]=retainAvailable(old?.[key],next);return result;
}
async function enrich(record,{providerRoot,cacheRoot,signal,progress={},save=()=>{},services={},previous,now=Date.now()}){
  const load=name=>services[name]||requireProvider(providerRoot,name),context=services.context||createContext(providerRoot,'https://source.invalid',null,{durableMetadata:true,componentCacheRoot:cacheRoot,signal});
  const out=structuredClone(record),tmdb=load('tmdb/index.js'),tvdb=load('tvdb/index.js');
  if(previous){
    for(const [key,value]of Object.entries(previous.info||{}))if(!(out.metadataPolicy?.providerArtworkOnly&&['poster','background','logo','cover','thumbnail'].includes(key))&&(out.info[key]==null||out.info[key]===''||Array.isArray(out.info[key])&&!out.info[key].length))out.info[key]=value;
    out.externalMedia=structuredClone(previous.externalMedia||{});out.artworkLibrary=structuredClone(previous.artworkLibrary||{});
  }
  const components=progress.__components||={};let phaseFailures=0;
  const failureCount=()=>Object.values(context.failureSnapshot?.()||{}).reduce((a,b)=>a+b,0)+(context.metadataTasks?.errorCount?.()||0);
  const checkpoint=async(key,fn)=>{signal?.throwIfAborted();
    if(components[key]?.nextCheckAt>now){phaseFailures++;return progress[key]??null;}
    if(!Object.hasOwn(progress,key)||components[key]){
    const before=failureCount(),webBefore=context.externalStatus?.tmdbWeb?.transientFailures||0,childrenBefore=phaseFailures;
    const phase=key.startsWith('tmdb:')?'tmdbPhases':key.startsWith('tvdb:')?'tvdbPhases':'wikidataPhases';
    try{
      const result=await metrics.phase(phase,fn);
      if(phaseFailures>childrenBefore)return result;
      if(failureCount()>before||(context.externalStatus?.tmdbWeb?.transientFailures||0)>webBefore)throw Error('External metadata request failed: '+key);
      progress[key]=result;delete components[key];save(progress);
    }catch(error){
      signal?.throwIfAborted();phaseFailures++;
      const attempts=(components[key]?.attempts||0)+1;
      components[key]={attempts,nextCheckAt:Math.max(now+Math.min(86400000,3600000*2**Math.min(attempts-1,5)),error.retryAt||0,context.retryAfterAt?.()||0),status:'retry',httpStatus:Number(error.response?.status)||null};
      save(progress);return progress[key]??null;
    }
  }else metrics.add('cache','checkpointHits');return progress[key];};
  const adapter=providerRoot&&!services['tmdb/index.js']?createTmdbAdapter(load,context,checkpoint):null;
  const policy=out.metadataPolicy||{},target=policy.tmdb;
  if(policy.providerArtworkOnly)out.artworkLibrary={};
  const type=target?.type||(out.info.type==='movie'?'movie':'tv'),tmdbId=policy.sourceOnly?0:Number(target?.id??out.sourceIds.tmdb);
  const scoped=target&&target.scope!=='work',differentType=type!==out.info.type;
  let tvdbId=Number(out.sourceIds.tvdb);
  if(policy.sourceOnly||scoped||differentType)tvdbId=0;
  if(tmdbId&&!scoped&&!differentType&&(!out.sourceIds.imdb||!tvdbId)&&(providerRoot||services['wikidata/index.js'])){
    const ids=await checkpoint('wikidata:ids',()=>load('wikidata/index.js').resolveWikidataExternalIds({providerContext:context,tmdbId,type}));
    const conflict=ids&&(policy.rejectedImdbIds?.includes(ids.imdbId)||(out.sourceIds.imdb&&ids.imdbId&&out.sourceIds.imdb!==ids.imdbId)||(tvdbId&&ids.tvdbId&&tvdbId!==Number(ids.tvdbId)));
    if(ids&&!conflict){out.externalIdsEvidence={wikidata:ids};out.sourceIds.imdb ||= ids.imdbId||null;out.sourceIds.tvdb ||= ids.tvdbId?String(ids.tvdbId):null;out.sourceIds.wikidata=ids.wikidataId;tvdbId=Number(out.sourceIds.tvdb);}
    else if(conflict)out.warnings.push({reason:'wikidata-external-id-conflict'});
  }
  const conflicts=new Set(out.warnings.filter(w=>w.season!==undefined).map(w=>w.season));
  if(tmdbId){const media=scoped?null:await checkpoint('tmdb:media',()=>adapter?adapter.media(tmdbId,type,out.info):tmdb.resolveTmdbMediaMetadata({providerContext:context,id:tmdbId,type}));
    out.info.synopsis ||= media?.overview?.value;out.externalMedia||={};if(media)out.externalMedia.tmdb=media;
    const values=mediaFields(media);
    for(const field of ['year','runtime','rating','genres','cast'])if(out.info[field]==null||out.info[field]===''||Array.isArray(out.info[field])&&!out.info[field].length)out.info[field]=values?.[field]?.value??values?.[field];
    const artwork=policy.providerArtworkOnly?null:await checkpoint('tmdb:artwork',()=>adapter?adapter.artwork(tmdbId,type,scoped?[target.season]:undefined):load('tmdb/artworkLibrary.js').resolveTmdbArtworkLibrary({providerContext:context,id:tmdbId,type,mappedSeasons:scoped?[target.season]:undefined}));
    if(artwork&&scoped)artwork.seasons=Object.fromEntries(Object.entries(artwork.seasons||{}).filter(([number])=>Number(number)===target.season));
    out.artworkLibrary||={};if(artwork)out.artworkLibrary.tmdb=retainAvailable(out.artworkLibrary.tmdb,artwork);
    if(target?.scope==='episode'){
      const data=await checkpoint('tmdb:scoped-episode',()=>tmdb.resolveTmdbEpisodeSeasonMetadata({providerContext:context,mediaId:tmdbId,seasonNumber:target.season,episodeNumbers:[target.episode]}));
      const episode=data?.episodes?.find(e=>Number(e.episodeNumber)===target.episode);
      if(episode){out.externalMedia||={};out.externalMedia.tmdbEpisode=episode;out.info.synopsis ||= episode.overview?.value;}
    }
    if(differentType&&type==='movie'&&policy.singleEpisode){
      const episode=out.seasons.find(s=>s.number===policy.singleEpisode.season)?.episodes.find(e=>Number(e.number)===policy.singleEpisode.episode);
      if(episode){episode.synopsis ||= media?.overview?.value;episode.externalMappings||={};episode.externalMappings.tmdb={status:'verified',id:tmdbId,type:'movie',method:'verified-override'};}
    }
  }
  if(tvdbId&&!out.info.synopsis&&tvdb.resolveTvdbMediaTextMetadata){const media=await checkpoint('tvdb:media',()=>tvdb.resolveTvdbMediaTextMetadata({providerContext:context,tvdbId,mediaType:type==='tv'?'series':'movie'}));out.info.synopsis ||= media?.synopsis;out.externalMedia||={};out.externalMedia.tvdb=media;}
  if(tvdbId&&!policy.providerArtworkOnly){out.artworkLibrary||={};const artwork=await checkpoint('tvdb:artwork',()=>load('tvdb/artworkLibrary.js').resolveTvdbArtworkLibrary({providerContext:context,tvdbId,mediaType:type==='tv'?'series':'movie',mappedSeasons:out.seasons.map(s=>s.number)}));if(artwork)out.artworkLibrary.tvdb=artwork;}
  for(const season of out.seasons){
    if(policy.sourceOnly||policy.providerEpisodesOnly||scoped||differentType||out.episodeMappingUncertain||conflicts.has(season.number))continue;
    const eligible=season.episodes.filter(e=>!needsEpisodeIdentity(e.number));
    const providerOnly=new Set(eligible.filter(e=>explicitTarget(out,season,e,'tmdb')?.providerOnly));
    for(const service of ['tmdb','tvdb']){
      const id=service==='tmdb'?tmdbId:tvdbId;if(!id)continue;
      for(const e of eligible){
        const explicit=explicitTarget(out,season,e,service);
        if(explicit){e.externalMappings||={};e.externalMappings[service]={status:explicit.providerOnly&&!explicit.episodes?'provider-only':'verified',id,season:explicit.season,...(explicit.episodes?{episodes:explicit.episodes}:{episode:explicit.episode}),method:explicit.method};}
      }
      const gaps=eligible.filter(e=>!providerOnly.has(e)&&!explicitTarget(out,season,e,service)?.providerOnly&&(!meaningful(e.title)||!e.synopsis||!policy.providerArtworkOnly&&!e.thumbnail));
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
        if(!m){if(explicit)e.externalMappings[service].metadataStatus='unavailable';else e.externalMappings[service]={status:'unverified',reason:'episode-identity-not-confirmed'};continue;}
        e.externalMappings[service]={status:'verified',id,season:targetSeason,episode:m.episodeNumber,method:explicit?.method||'unique-title-and-number'};
        const fields=service==='tmdb'?{title:m.title?.value,synopsis:m.overview?.value,thumbnail:m.thumbnail}:{title:m.title,synopsis:m.synopsis,thumbnail:m.thumbnail};
        if(policy.providerArtworkOnly)delete fields.thumbnail;
        e.metadataSources[service]=fields;
        for(const k of Object.keys(fields))if((k==='title'?!meaningful(e[k]):!e[k])&&fields[k]){e[k]=fields[k];out.provenance[`${season.number}:${e.number}:${k}`]=service;}
      }
    }
  }
  const tasks=context.metadataTasks?.snapshot()||{};out.metadataTasks=tasks;out.sourceStatus=context.externalStatus;
  const failed=phaseFailures>0||Object.keys(components).length>0;
  if(failed&&previous){
    for(const season of out.seasons)for(const episode of season.episodes){
      const old=previous.seasons?.find(s=>s.number===season.number)?.episodes?.find(e=>String(e.number)===String(episode.number));
      if(!old)continue;
      for(const field of ['title','synopsis','thumbnail'])if(!(policy.providerArtworkOnly&&field==='thumbnail')&&(field==='title'?!meaningful(episode[field]):!episode[field])&&old[field]){
        episode[field]=old[field];const key=`${season.number}:${episode.number}:${field}`;if(previous.provenance?.[key])out.provenance[key]=previous.provenance[key];
      }
      episode.externalMappings={...old.externalMappings,...episode.externalMappings};episode.metadataSources={...old.metadataSources,...episode.metadataSources};
    }
  }
  const missing=out.seasons.some(s=>s.episodes.some(e=>!meaningful(e.title)||!e.synopsis||!e.thumbnail));
  out.enrichment={status:failed?'retry':policy.sourceOnly?'ready':!tmdbId&&!tvdbId?'unmapped':'ready',hasMissingEpisodeMetadata:missing,...(policy.sourceOnly?{resolution:'provider-only-confirmed'}:{}),
    ...(failed?{pendingComponents:Object.keys(components),nextCheckAt:Math.min(...Object.values(components).map(c=>c.nextCheckAt))}:{} )};
  return out;
}
module.exports={enrich};
