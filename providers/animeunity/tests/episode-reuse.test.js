'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reusableEpisodes}=require('../scripts/episode-reuse');
const {mappingFingerprint}=require('../scripts/incremental');
const {enrichAnime}=require('../scripts/vega');
function fixture(){
  const mapped={sourceIds:{},mappings:{targets:[]},providerRef:'v1'};
  const raw={fingerprint:'new-source',id:1,path:'/anime/1-x',info:{},episodes:[{id:10,number:'1'},{id:11,number:'2'}]};
  const previous={rawFingerprint:'old-source',id:1,path:raw.path,providerRef:'v1',mappingFingerprintVersion:2,mappingFingerprint:mappingFingerprint(mapped),
    enrichmentSchemaVersion:2,episodeSafetyVersion:1,updatedAt:new Date().toISOString(),sourceEpisodes:[raw.episodes[0]],
    episodes:[{link:'10',title:'Resolved title',synopsis:'Plot',thumbnail:'image'}],metadataTasks:{}};
  return {mapped,raw,previous};
}
test('only new episodes are sent to gap filling and known episodes are supplied to Vega',async()=>{
  const {mapped,raw,previous}=fixture();let known,gaps;
  const result=await enrichAnime('.','https://www.animeunity.co',raw,mapped,{previousFinal:previous,
    getMeta:async()=>({title:'Test',linkList:[{episodesLink:'1|1|2'}]}),
    getEpisodes:async args=>{known=args.knownEpisodes;return [...known,{link:'11',title:'New'}];},
    fillTvdbEpisodeGaps:async(_p,_c,rows)=>{gaps=[...rows.keys()];},collectArtwork:async()=>({})});
  assert.equal(known.length,1);assert.deepEqual(gaps,['11']);assert.equal(result.episodes.length,2);
  assert.equal(result.episodes.find(e=>e.link==='10').title,'Resolved title');
  assert.equal(result.episodeCheckedAt['10'],previous.updatedAt);assert.ok(result.episodeCheckedAt['11']);
});
test('real source changes, position changes, mapping changes and due tasks prevent unsafe reuse',()=>{
  const {mapped,raw,previous}=fixture();assert.equal(reusableEpisodes(previous,raw,mapped).length,1);
  const moved=structuredClone(raw);moved.episodes.reverse();assert.equal(reusableEpisodes(previous,moved,mapped).length,0);
  const changed=structuredClone(raw);changed.episodes[0].number='3.5';assert.equal(reusableEpisodes(previous,changed,mapped).length,0);
  assert.equal(reusableEpisodes(previous,raw,{...mapped,ids:{tmdbShowIds:[42]}}).length,0);
  previous.metadataTasks={x:{kind:'episodes',nextCheckAt:0}};assert.equal(reusableEpisodes(previous,raw,mapped).length,0);
});
test('counter changes reuse metadata while removals and independent episode expiry are respected',()=>{
  const {mapped,raw,previous}=fixture();raw.episodes[0].visite=100;
  assert.equal(reusableEpisodes(previous,raw,mapped).length,1);
  previous.episodeCheckedAt={'10':new Date(Date.now()-91*86400000).toISOString()};
  assert.equal(reusableEpisodes(previous,raw,mapped).length,0);
  delete previous.episodeCheckedAt;raw.episodes.shift();assert.equal(reusableEpisodes(previous,raw,mapped).length,0);
});
test('missing fields are retried after 30 days even when the record was recently rebuilt',()=>{
  const {mapped,raw,previous}=fixture();delete previous.episodes[0].synopsis;
  previous.episodeCheckedAt={'10':new Date(Date.now()-31*86400000).toISOString()};
  assert.equal(reusableEpisodes(previous,raw,mapped).length,0);
});

test('episode reuse keeps original age through partial checkpoints and removes disappeared episodes',async()=>{
  const {mapped,raw,previous}=fixture();const old=previous.updatedAt;let saved;
  const options={previousFinal:previous,getMeta:async()=>({title:'Test',linkList:[{episodesLink:'first'},{episodesLink:'second'}]}),
    getEpisodes:async({url,knownEpisodes})=>url==='first'?knownEpisodes:[{link:'11',title:'Second'}],
    fillTvdbEpisodeGaps:async()=>{},collectArtwork:async()=>({}),checkpoint:v=>{saved=v;},maxGroups:1};
  const partial=await enrichAnime('.','https://www.animeunity.co',raw,mapped,options);
  assert.equal(partial.partial,true);assert.equal(saved.episodeCheckedAt['10'],old);
  const finished=await enrichAnime('.','https://www.animeunity.co',raw,mapped,{...options,progress:partial.progress});
  assert.equal(finished.episodes.length,2);assert.equal(finished.episodeCheckedAt['10'],old);
  const reduced={...raw,episodes:[raw.episodes[1]]};
  const removed=await enrichAnime('.','https://www.animeunity.co',reduced,mapped,{...options,maxGroups:Infinity,
    getMeta:async()=>({title:'Test',linkList:[]})});
  assert.deepEqual(removed.episodes.map(e=>e.link),['11']);
});

test('independent episode expiry schedules enrichment despite recently updated record',()=>{
  const {enrichmentDue}=require('../scripts/pipeline');const {previous}=fixture();
  previous.info={poster:'p',logo:'l',background:'b'};
  previous.episodeCheckedAt={'10':new Date(Date.now()-91*86400000).toISOString()};
  assert.equal(enrichmentDue(previous),true);
  previous.episodeCheckedAt['10']=new Date().toISOString();assert.equal(enrichmentDue(previous),false);
});
