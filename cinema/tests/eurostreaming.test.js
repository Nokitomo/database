'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {group,mergeGroup,loadSources}=require('../scripts/catalog');
const {resolve,identify}=require('../scripts/identity');
const {enrich}=require('../scripts/enrich'),{run}=require('../scripts/pipeline');
const {read,write}=require('../../shared/storage/json');
function tmp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-euro-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function entry(provider,id,sourceIds={imdb_id:'tt39980704'}){return {provider,key:provider+':'+id,record:{id,active:true,path:provider==='streamingunity'?`/it/titles/${id}-yaga`:provider==='altadefinizione'?`/serie-tv/${id}-yaga-streaming.html`:'/yaga/',locale:'it',provider,info:{name:'Yaga',type:'tv',year:2026},sourceIds,images:[],seasonIndex:[{id:1,number:1}],seasons:[{id:1,number:1,episodes:[{number:1,name:'Episodio 1',images:[]}]}],...(provider==='eurostreaming'?{episodeBlocks:[],episodeMappingUncertain:true}:{})}};}
test('Eurostreaming joins shared IMDb without changing established primary metadata or work ID',()=>{
 const su=entry('streamingunity',1,{imdb_id:'tt39980704',tmdb_id:314360}),alta=entry('altadefinizione',2,{imdb_id:'tt39980704',tmdb_id:314360}),e=entry('eurostreaming',3);
 su.record.info.name='Preferred';const initial=group([su,alta]);const next=group([su,alta,e],initial.registry),r=mergeGroup(next.groups[0]);
 assert.equal(next.groups.length,1);assert.equal(next.groups[0].id,initial.groups[0].id);assert.equal(r.info.title,'Preferred');assert(r.providers.eurostreaming);assert.equal(r.episodeMappingUncertain,false);
});
test('unknown external IDs never merge on title and Eurostreaming numbering cannot drive enrichment',async()=>{
 const e=entry('eurostreaming',3,{tmdb_id:314360}),r=mergeGroup(group([e]).groups[0]);
 const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:()=>assert.fail('unverified episode mapping')},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}};
 await enrich(r,{services});assert.equal(group([entry('eurostreaming',4,{}),entry('streamingunity',1,{})]).groups.length,2);
});
test('IMDb lookup confirms reverse external ID and respects movie/tv type',async()=>{
 const calls=[],context={axios:{get:async(u,o)=>{calls.push([u,o]);return {data:u.includes('/find/')?{tv_results:[{id:123}],movie_results:[{id:456}]}:{imdb_id:'tt39980704',tvdb_id:789}};}}};
 const r=await resolve(entry('eurostreaming',1).record,{context,apiKey:'test'});assert.equal(r.tmdb_id,123);assert.equal(r.tvdb_id,789);assert.equal(r.status,'verified');assert.equal(calls.length,2);
 const wrong={axios:{get:async u=>({data:u.includes('/find/')?{tv_results:[{id:123}]}:{imdb_id:'tt999999'}})}};
 assert.notEqual((await resolve(entry('eurostreaming',1).record,{context:wrong,apiKey:'test'})).status,'verified');
});
test('search without source IDs returns candidates only, even for a single exact result',async()=>{
 const context={axios:{get:async()=>({data:{results:[{id:123,name:'Yaga',first_air_date:'2026-01-01'}]}})}};
 const r=await resolve(entry('eurostreaming',1,{}).record,{context,apiKey:'test'});assert.equal(r.status,'needs-review');assert.equal(r.tmdb_id,undefined);
});
test('TMDB web fallback verifies IMDb backlink and rejects challenge responses',async()=>{
 const context={axios:{get:async u=>{if(u.includes('api.'))throw Error('API failure');return {data:u.includes('/search/')?'<title>The Movie Database</title><a href="/tv/123-yaga">Yaga</a>':'<a href="https://www.imdb.com/title/tt39980704/">IMDb</a>'};}}};
 const r=await resolve(entry('eurostreaming',1).record,{context,apiKey:'test'});assert.equal(r.status,'verified');assert.equal(r.method,'tmdb-web-imdb-backlink');
 await assert.rejects(resolve(entry('eurostreaming',1).record,{apiKey:'',context:{axios:{get:async()=>({data:'<title>Just a moment</title>'})}}}),/Invalid/);
});
test('identity cache resumes, changes invalidate it, transport errors retry, local matching avoids requests',async t=>{
 const output=tmp(t),source={entries:[entry('eurostreaming',1)]};let calls=0;
 const lookup=async()=>{calls++;return {status:'verified',tmdb_id:10};};
 await identify(source,{output,now:100,deadline:Date.now()+10000,lookup});assert.equal(source.entries[0].record.sourceIds.tmdb_id,10);
 source.entries=[entry('eurostreaming',1)];await identify(source,{output,now:101,deadline:Date.now()+10000,lookup});assert.equal(calls,1);
 source.entries=[entry('eurostreaming',1,{imdb_id:'tt999999'})];await identify(source,{output,now:102,deadline:Date.now()+10000,lookup:async()=>{throw Error('network');}});assert.equal(source.entries[0].record.identity.status,'retry');
 source.entries=[entry('eurostreaming',2),entry('streamingunity',3,{imdb_id:'tt39980704',tmdb_id:20})];await identify(source,{output,now:103,deadline:Date.now()+10000,lookup:()=>assert.fail()});assert.equal(source.entries[0].record.sourceIds.tmdb_id,20);
});
test('cinema publishes existing catalogs before first Eurostreaming snapshot, then adds verified source',async t=>{
 const root=tmp(t),roots={};
 function source(provider,id,ids){roots[provider]=path.join(root,provider);const store=require(`../../providers/${provider}/scripts/store`),s=store.initialState(),r=entry(provider,id,ids).record;
  s.known[id]={id,active:true};s.archive={completedAt:1,total:1};s.origins={site:'https://example.invalid'};write(store.itemFile(roots[provider],id),r);store.publish(roots[provider],s,{complete:true});}
 source('streamingunity',1,{tmdb_id:10,imdb_id:'tt39980704'});source('altadefinizione',2,{tmdb_id:10,imdb_id:'tt39980704'});
 const output=path.join(root,'out'),ready=async r=>({...r,enrichment:{status:'ready'}});
 await run({roots,output,enrich:ready,now:1});assert.deepEqual(read(path.join(output,'manifest.json')).awaitingProviders,['eurostreaming']);
 source('eurostreaming',3,{imdb_id:'tt39980704'});const r=await run({roots,output,enrich:ready,now:2,identityLookup:()=>assert.fail('local match available')});assert.equal(r.count,1);assert.deepEqual(read(path.join(output,'manifest.json')).awaitingProviders,[]);
 assert(read(path.join(output,'items/work-1.json')).providers.eurostreaming);
});
test('expired verified identity survives a transient lookup failure, including merge-only replay',async t=>{
 const output=tmp(t),source={entries:[entry('eurostreaming',1)]};
 await identify(source,{output,now:100,deadline:Date.now()+10000,lookup:async()=>({status:'verified',tmdb_id:10})});
 source.entries=[entry('eurostreaming',1)];await identify(source,{output,now:31*86400000,deadline:Date.now()+10000,lookup:async()=>{throw Error('network');}});
 assert.equal(source.entries[0].record.sourceIds.tmdb_id,10);assert.equal(source.entries[0].record.identity.status,'retry');
 source.entries=[entry('eurostreaming',1)];await identify(source,{output,now:31*86400000+1,deadline:Date.now()+10000,limit:0,lookup:()=>assert.fail()});assert.equal(source.entries[0].record.sourceIds.tmdb_id,10);
});
