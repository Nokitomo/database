'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {needsEpisodeIdentity, protectSourceEpisodes} = require('../scripts/episode-safety');
const {createContext, enrichAnime, fillTvdbEpisodeGaps} = require('../scripts/vega');
const {enrichWorld} = require('../unified/scripts/enrich');
test('ambiguous labels retain provider data and discard all old external metadata', () => {
  for (const number of ['0','3.5','4.5','3-4','SP']) {
    assert(needsEpisodeIdentity(number));
    const source={id:7,number}, map=new Map([['7',{link:'7',title:'Wrong',synopsis:'Wrong',thumbnail:'wrong',externalMappings:[{}],metadataSources:{tmdb:{}},seasonNumber:1}]]);
    protectSourceEpisodes(map,[source]);const e=map.get('7');
    assert.equal(e.title,`Episode ${number}`);assert.equal(e.synopsis,undefined);assert.equal(e.thumbnail,undefined);
    assert.equal(e.externalMappings,undefined);assert.equal(e.seasonNumber,undefined);
    assert.equal(e.thumbnailFallback.type,'series-background');
    protectSourceEpisodes(map,[{...source,title:'Provider title',plot:'Provider plot',image:'provider.jpg'}]);
    assert.equal(map.get('7').thumbnail,'provider.jpg');assert.equal(map.get('7').thumbnailFallback,undefined);
  }
  assert.equal(needsEpisodeIdentity('1'),false);assert.equal(needsEpisodeIdentity('1180'),false);
});
test('AnimeUnity preserves record alignment and strips ambiguous metadata before publication',async()=>{
  const raw={id:1,slug:'x',path:'/anime/1-x',info:{},episodes:[{id:10,number:'3.5'},{id:11,number:'1'}]};
  const ctx=createContext('.','https://www.animeunity.co',raw);
  const r=await ctx.axios.get('https://www.animeunity.co/info_api/1/1?start_range=0&end_range=10');
  assert.deepEqual(r.data.episodes.map(e=>e.id),[10,11]);
  const final=await enrichAnime('.','https://www.animeunity.co',raw,{sourceIds:{},mappings:{}},{
    getMeta:async()=>({title:'X',linkList:[]}),getEpisodes:async()=>[],
    fillTvdbEpisodeGaps:async()=>{},collectArtwork:async()=>({poster:[],logo:[],background:[]}),
    progress:{info:{title:'X',linkList:[]},episodes:[{link:'10',title:'Wrong',synopsis:'Wrong'}]}});
  assert.equal(final.episodes.find(e=>e.link==='10').title,'Episode 3.5');
  assert.equal(final.episodeSafetyVersion,1);
});
test('TVDB cannot fill unresolved episodes, regular season zero remains valid',async()=>{
  const map=new Map([['1',{metadataMappingStatus:'unresolved',externalMappings:[{provider:'tvdb_show',id:'1',seasonNumber:0,episodeNumbers:[1]}]}],
    ['2',{title:'Episode 1',externalMappings:[{provider:'tvdb_show',id:'1',seasonNumber:0,episodeNumbers:[2]}]}]]);
  await fillTvdbEpisodeGaps('.',{},map,{info:{}},async args=>{assert.equal(args.seasonNumber,0);assert.deepEqual(args.episodeNumbers,[2]);return [];});
});
test('unified enrichment never invokes episode mapping or AniZip for fractions and zero',async()=>{
  const record={id:1,info:{title:'X',type:'TV'},sourceIds:{},episodes:[{id:1,number:'0'},{id:2,number:'4.5'}]};
  const result=await enrichWorld(record,{providerRoot:'.',services:{
    context:{},'mappings/index.js':{resolveAnimeMappings:async()=>({targets:[],metadataTargets:[]}),buildAniBridgeExtra:()=>({}),
      resolveAniBridgeEpisodeMappings:()=>{throw Error('must not map');}},'tmdb/index.js':{},
    fillGaps:async()=>{},artwork:async()=>({})}});
  assert.equal(result.episodes.length,2);assert(result.episodes.every(e=>e.metadataMappingStatus==='unresolved'));
});
