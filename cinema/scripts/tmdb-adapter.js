'use strict';
// Database-only orchestration: the pinned Vega build and its selection helpers stay unchanged.
function createTmdbAdapter(load, context, checkpoint) {
  const api=load('tmdb/api.js'),tmdb=load('tmdb/index.js');
  const locales=load('tmdb/locales.js');
  const checkedContext={...context,axios:{...context.axios,get:async(url,options)=>{
    const response=await context.axios.get(url,options),u=new URL(url);
    if(u.hostname==='api.themoviedb.org'){
      const body=response?.data;
      if(!body||typeof body!=='object'||Array.isArray(body)||body.success===false)throw Error('Invalid TMDB API response');
      const media=/^\/3\/(movie|tv)\/(\d+)$/.exec(u.pathname);
      if(media&&(Number(body.id)!==Number(media[2])||media[1]==='tv'&&!Array.isArray(body.seasons)))throw Error('Invalid TMDB media response');
      if(u.pathname.endsWith('/images')){
        const fields=/\/season\/\d+\/images$/.test(u.pathname)?['posters']:['posters','backdrops','logos'];
        if(fields.some(field=>!Array.isArray(body[field])||body[field].some(image=>!image||typeof image.file_path!=='string'||!image.file_path.startsWith('/'))))throw Error('Invalid TMDB image inventory');
      }
    }
    return response;
  }}};
  const argsFor=(id,type)=>({providerContext:checkedContext,id,type});
  const isMissing=v=>v==null||v===''||Array.isArray(v)&&!v.length;
  return {
    async media(id,type,info){
      const fields=['synopsis','year','runtime','rating','genres','cast'].filter(field=>isMissing(info[field]));
      if(!fields.length)return null;
      const args=argsFor(id,type),apiKey=await api.readTmdbApiKey(checkedContext);
      if(apiKey){
        const data=await api.resolveApiMedia({...args,apiKey,includeImages:false,includeCredits:fields.includes('cast')});
        const values=mediaFields(data);
        const missing=fields.filter(field=>field==='synopsis'?!data?.overview?.value:isMissing(values[field]));
        if(data&&!missing.length)return data;
        const fallback=await tmdb.resolveTmdbInfoFields({...args,fields:(data?missing:fields).map(f=>f==='synopsis'?'overview':f)});
        if(!fallback&&!data)throw Error('TMDB media unavailable');
        return fallback||data;
      }
      const fallback=await tmdb.resolveTmdbInfoFields({...args,fields:fields.map(f=>f==='synopsis'?'overview':f)});
      if(!fallback)throw Error('TMDB media unavailable');return fallback;
    },
    async artwork(id,type,mappedSeasons){
      const args=argsFor(id,type),apiKey=await api.readTmdbApiKey(checkedContext);
      if(!apiKey){const fallback=await load('tmdb/artworkLibrary.js').resolveTmdbArtworkLibrary(args);if(!fallback)throw Error('TMDB artwork unavailable');return fallback;}
      const getInventory=seasonNumber=>checkpoint(`tmdb:inventory-v2:${seasonNumber??'series'}`,async()=>{
        const inventory=await api.resolveApiImageInventory({...args,apiKey,seasonNumber});
        if(!inventory)throw Error('TMDB image inventory unavailable');
        return inventory;
      });
      const inventory=await getInventory();
      const originalLanguage=inventory?.originalLanguage;
      const slots=(value,season=false)=>{
        const out={};
        for(const [field,route]of Object.entries(season?{poster:'posters'}:{poster:'posters',background:'backdrops',logo:'logos'})){
          out[field]={};
          for(const locale of field==='logo'?locales.buildLogoLocalePriority():locales.buildLocalePriority(originalLanguage)){
            const language=locales.languageCodeFromLocale(locale);
            const candidates=value?.images[route]?.filter(image=>image.language===language)||[];
            out[field][language]={status:!value?'unavailable':candidates.length?'available':'missing',selected:candidates[0],candidates};
          }
        }
        return out;
      };
      const seasons={};
      if(type==='tv'){
        const layout=await checkpoint('tmdb:layout-v2',async()=>{
          const data=await api.resolveApiMedia({...args,apiKey,includeImages:false,includeCredits:false});
          if(!data)throw Error('TMDB season layout unavailable');
          return data.seasons;
        });
        for(const season of (layout||[]).filter(s=>!mappedSeasons||mappedSeasons.includes(s.seasonNumber))){
          const value=await getInventory(season.seasonNumber);
          seasons[season.seasonNumber]={images:slots(value,true),logo:{status:'unsupported',inheritedFrom:'series.logo'},background:{status:'unsupported',inheritedFrom:'series.background'}};
        }
      }
      return {schemaVersion:1,source:'tmdb',id,type,originalLanguage,series:slots(inventory),seasons};
    },
  };
}
function mediaFields(media){
  const date=media?.releaseDate||media?.startDate;
  const year=Number(/^\d{4}/.exec(date||'')?.[0])||undefined;
  const runtime=Number(/^(\d+(?:\.\d+)?)m$/.exec(media?.facts?.Runtime||'')?.[1])||undefined;
  return {...media,year:media?.year??year,runtime:media?.runtime??runtime};
}
module.exports={createTmdbAdapter,mediaFields};
