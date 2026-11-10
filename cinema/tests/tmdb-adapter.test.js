'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTmdbAdapter,mediaFields}=require('../scripts/tmdb-adapter');
const {enrich}=require('../scripts/enrich');
const {createPacedGet}=require('../../providers/animeunity/scripts/rate-limit');
function setup(){
  let web=0,calls=[];
  const inventory={originalLanguage:'ja-JP',images:{posters:[{language:'it',url:'first'},{language:'it',url:'second'},{language:'ja',url:'japanese'},{language:'xx',url:'neutral'}],logos:[],backdrops:[]}};
  const modules={
    'tmdb/api.js':{readTmdbApiKey:async()=> 'key',resolveApiImageInventory:async a=>{calls.push(a.seasonNumber??'series');return inventory;},resolveApiMedia:async()=>({seasons:[{seasonNumber:0},{seasonNumber:1}],releaseDate:'2020-01-01',facts:{Runtime:'24m'}})},
    'tmdb/index.js':{resolveTmdbInfoFields:async()=>{web++;return null;}},
    'tmdb/locales.js':{buildLocalePriority:original=>[...new Set(['it-IT','en-US',original,'xx-XX'].filter(Boolean))],buildLogoLocalePriority:()=>['it-IT','en-US','xx-XX'],languageCodeFromLocale:l=>l.split('-')[0]},
    'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>{web++;return {web:true};}},
  };
  const adapter=createTmdbAdapter(n=>modules[n],{axios:{get:async()=>({data:{}})}},async(k,fn)=>fn());
  return {adapter,modules,calls,get web(){return web;}};
}
test('API inventory keeps language order, absent logos and season zero without web calls',async()=>{
  const f=setup(),out=await f.adapter.artwork(1,'tv');
  assert.equal(f.web,0);assert.deepEqual(f.calls,['series',0,1]);
  assert.equal(out.series.poster.it.selected.url,'first');assert.equal(out.series.poster.ja.selected.url,'japanese');
  assert.equal(out.series.logo.xx.status,'missing');assert(!out.series.logo.ja);
  assert.equal(out.seasons[0].logo.status,'unsupported');
});
test('known provider fields skip media requests; year and runtime use correct API fields',async()=>{
  const f=setup();assert.equal(await f.adapter.media(1,'movie',{synopsis:'x',year:2020,runtime:24,rating:5,genres:['x'],cast:['x']}),null);
  const result=await f.adapter.media(1,'movie',{synopsis:'x',rating:5,genres:['x'],cast:['x']});
  assert.equal(f.web,0);assert.equal(mediaFields(result).year,2020);assert.equal(mediaFields(result).runtime,24);
});
test('no API key preserves web fallback and malformed inventory is not accepted as empty',async()=>{
  const f=setup();f.modules['tmdb/api.js'].readTmdbApiKey=async()=>undefined;
  assert.deepEqual(await f.adapter.artwork(1,'movie'),{web:true});
  f.modules['tmdb/api.js'].readTmdbApiKey=async()=> 'key';
  f.modules['tmdb/api.js'].resolveApiImageInventory=async a=>{await a.providerContext.axios.get('https://api.themoviedb.org/3/movie/1/images');return null;};
  await assert.rejects(f.adapter.artwork(1,'movie'),/Invalid TMDB image inventory/);
});
test('long Retry-After blocks subsequent calls and keeps HTTP 429 evidence',async()=>{
  let calls=0,clock=0;const get=createPacedGet(async()=>{calls++;throw {response:{status:429,headers:{'retry-after':'120'}}};},{now:()=>clock,sleep:async ms=>{clock+=ms;}});
  for(let i=0;i<2;i++)await assert.rejects(get('https://api.themoviedb.org/3/movie/1'),e=>e.response.status===429&&e.retryAt===120000);
  assert.equal(calls,1);clock=120001;
  await assert.rejects(get('https://api.themoviedb.org/3/movie/2'));assert.equal(calls,2);
});
test('cooldown survives a new limiter instance and expiry allows requests again',async()=>{
  let until=0,calls=0,clock=0;const store={read:()=>until,write:(host,value)=>{until=value;}};
  const options={now:()=>clock,sleep:async ms=>{clock+=ms;}};
  const first=createPacedGet(async()=>{calls++;throw {response:{status:429,headers:{'retry-after':'7200'}}};},options);
  await assert.rejects(first('https://api.themoviedb.org/3/movie/1',{},store));
  const next=createPacedGet(async()=>{calls++;return {status:200};},options);
  await assert.rejects(next('https://api.themoviedb.org/3/movie/2',{},store),e=>e.retryAt===7200000);
  assert.equal(calls,1);clock=7200001;await next('https://api.themoviedb.org/3/movie/2',{},store);assert.equal(calls,2);
});
test('independent phases continue after an error and only failed components retry',async()=>{
  const r={info:{type:'movie'},sourceIds:{tmdb:'1',tvdb:'2',imdb:'tt1'},warnings:[],seasons:[],provenance:{}};
  let tmdbCalls=0,tvdbCalls=0,fail=true;const progress={};
  const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({overview:{value:'plot'},releaseDate:'2021-01-01',facts:{Runtime:'90m'}})},'tvdb/index.js':{},
    'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>{tmdbCalls++;if(fail)throw Error('failed');return {ok:true};}},
    'tvdb/artworkLibrary.js':{resolveTvdbArtworkLibrary:async()=>{tvdbCalls++;return {ok:true};}}};
  let out=await enrich(r,{services,progress,now:1});assert.equal(out.enrichment.status,'retry');assert(out.artworkLibrary.tvdb.ok);assert.equal(out.info.year,2021);
  out=await enrich(r,{services,progress,now:2});assert.equal(tmdbCalls,1);assert.equal(tvdbCalls,1);
  fail=false;out=await enrich(r,{services,progress,now:3600002});assert.equal(out.enrichment.status,'ready');assert.equal(tmdbCalls,2);assert.equal(tvdbCalls,1);
});

test('scoped artwork collects only the verified season while preserving series image slots',async()=>{
 const f=setup(),out=await f.adapter.artwork(1,'tv',[1]);assert.deepEqual(f.calls,['series',1]);assert.deepEqual(Object.keys(out.seasons),['1']);assert(out.series.poster.it.selected);
});
