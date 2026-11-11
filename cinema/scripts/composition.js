'use strict';
function labelSeasons(seasons){
  for(const s of seasons){const duplicate=seasons.filter(v=>v.name===s.name).length>1;
    s.displayName=duplicate&&s.year?`${s.name} (${s.year})`:s.name||`Stagione ${s.number}`;
  }
}
function value(v){return v&&typeof v==='object'&&'value'in v?v.value:v;}
function applyContainer(record,media){
  if(!media)return;
  const fields={title:value(media.title),name:value(media.title),synopsis:value(media.overview),plot:value(media.overview),original_name:media.originalTitle,year:Number(String(media.startDate||media.releaseDate||'').slice(0,4))||null,status:media.status,rating:media.rating,genres:media.genres,cast:media.cast,poster:media.poster,background:media.background,logo:media.logo};
  for(const [key,v]of Object.entries(fields))if(v!=null&&v!==''&&(!Array.isArray(v)||v.length)){record.info[key]=v;record.provenance['info:'+key]='tmdb';}
  for(const season of record.seasons){const s=media.seasons?.find(s=>s.seasonNumber===season.number);if(!s)continue;
    for(const [key,v]of Object.entries({name:value(s.name),synopsis:value(s.overview),year:s.year,poster:s.poster}))if(v!=null&&v!=='')season[key]=v;
  }
  labelSeasons(record.seasons);
}
function selected(slots){return Object.values(slots||{}).find(v=>v.status==='available'&&v.selected?.url)?.selected.url;}
function applyContainerArtwork(record){
  const library=record.artworkLibrary?.tmdb;
  for(const field of ['poster','background','logo']){const url=selected(library?.series?.[field]);if(url)record.info[field]=url;}
  for(const season of record.seasons){const url=selected(library?.seasons?.[season.number]?.images?.poster);if(url)season.poster=url;}
}
function verifyComposition(record){
  const policy=record.metadataPolicy?.catalog;if(!policy||!record.active)return;
  const numbers=new Set();
  for(const season of record.seasons){
    if(numbers.has(season.number))throw Error('Duplicate composed season');numbers.add(season.number);
    if(policy.kind==='seasons'&&(!season.name||!policy.seasonMetadata[season.number]))throw Error('Unmapped composed season');
    for(const episode of season.episodes){
      if(!episode.playbackSources?.length)throw Error('Missing composed playback sources');
      for(const ref of episode.playbackSources){
        const variant=record.providers[ref.provider]?.find(v=>String(v.id)===String(ref.titleId));
        const source=variant?.seasons.find(s=>s.number===ref.season)?.episodes.find(e=>String(e.number)===String(ref.episode));
        if(!source||String(source.id??null)!==String(ref.episodeId)||variant.path!==ref.path)throw Error('Invalid composed playback reference');
        const expected=policy.kind==='seasons'?policy.seasonMaps[ref.provider+':'+ref.titleId]?.[ref.season]:ref.season;
        if(expected!==season.number||String(ref.episode)!==String(episode.number))throw Error('Incorrect composed playback coordinates');
      }
    }
  }
}
module.exports={labelSeasons,applyContainer,applyContainerArtwork,verifyComposition};
