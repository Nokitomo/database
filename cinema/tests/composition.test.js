'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {group,mergeGroup}=require('../scripts/catalog'),{enrich}=require('../scripts/enrich'),policy=require('../identity-overrides.json');
const {write,read}=require('../../shared/storage/json');
function entry(id,tmdb=2328,type='tv',counts=[22,22]){return {key:'streamingunity:'+id,provider:'streamingunity',record:{id,provider:'streamingunity',locale:'it',path:`/it/titles/${id}-source`,active:true,sourceIds:{tmdb_id:tmdb,imdb_id:'tt'+tmdb},info:{id,name:'Provider '+id,type,plot:'Component plot',release_date:'2017-01-01'},images:[],seasons:type==='movie'?[]:counts.map((count,i)=>({id:id*10+i,number:i+1,episodes:Array.from({length:count},(_,n)=>({id:id*100+n+i*30,number:n+1,name:'Episode '+(n+1),plot:'Provider plot '+n,thumbnail:'provider.jpg',images:[]}))}))}};}
const power=()=>[entry(9099),entry(9144),entry(9145,2328,'tv',[10])];
test('confirmed variants merge into one work while preserving both original records and preferred source',()=>{
 for(const [a,b,primary,tmdb,type]of [[14220,36022,36022,1178532,'movie'],[8639,8774,8639,1071815,'movie'],[27167,3875,3875,130245,'tv'],[5649,8811,8811,1018648,'movie']]){
 const entries=[entry(a,tmdb,type,[3]),entry(b,tmdb,type,[3])],before=structuredClone(entries),g=group(entries);assert.equal(g.groups.length,1);const r=mergeGroup(g.groups[0]);assert.deepEqual(entries,before);
 assert.equal(r.providers.streamingunity.length,2);assert.equal(r.providers.streamingunity[0].id,primary);assert(r.providers.streamingunity[0].preferred);assert.equal(r.metadataPolicy.catalog.timelineCompatibility,'unverified');
 if(type==='tv'){assert.equal(r.seasons[0].episodes.length,3);for(const e of r.seasons[0].episodes)assert.equal(e.playbackSources.length,2);}
 }
});
test('Power Rangers composes 98 source episodes into five named seasons without changing playback coordinates',()=>{
 const entries=power(),before=structuredClone(entries),r=mergeGroup(group(entries).groups[0]);assert.deepEqual(entries,before);assert.equal(r.info.title,'Power Rangers');assert.equal(r.info.plot,undefined);
 assert.deepEqual(r.seasons.map(s=>s.number),[24,25,28,29,30]);assert.equal(r.seasons.reduce((n,s)=>n+s.episodes.length,0),98);
 assert.equal(r.seasons[2].displayName,'Power Rangers Dino Fury (2021)');assert.equal(r.seasons[3].displayName,'Power Rangers Dino Fury (2022)');
 for(const [i,id,sourceSeason]of [[0,9099,1],[1,9099,2],[2,9144,1],[3,9144,2],[4,9145,1]])for(const e of r.seasons[i].episodes){assert.equal(e.playbackSources[0].titleId,id);assert.equal(e.playbackSources[0].season,sourceSeason);assert.equal(e.playbackSources[0].episode,e.number);assert(e.playbackSources[0].episodeId);}
 assert.deepEqual(r.providers.streamingunity[0].seasons,before[0].record.seasons);
});
test('unknown future seasons remain in the provider inventory and never collide with mapped seasons',()=>{
 const entries=power();entries[0].record.seasons.push({id:999,number:3,episodes:[{id:999,number:1,name:'Future'}]});const r=mergeGroup(group(entries).groups[0]);assert.deepEqual(r.seasons.map(s=>s.number),[24,25,28,29,30]);assert(r.warnings.some(w=>w.reason==='unmapped-provider-season'));assert.equal(r.providers.streamingunity[0].seasons.length,3);
});
test('composition validation rejects overlapping seasons and changed TMDB identities',()=>{
 const p=structuredClone(policy),rule=p.decisions.find(r=>r.catalog?.kind==='seasons');rule.catalog.seasonMaps['streamingunity:9144']['1']=24;assert.throws(()=>group(power(),undefined,p),/Overlapping/);
 const e=power();e[0].record.sourceIds.tmdb_id=99;assert.throws(()=>group(e),/conflicting|identity changed/);
});
test('container metadata and artwork replace component metadata and retain only available seasons',async()=>{
 const r=mergeGroup(group(power()).groups[0]);const out=await enrich(r,{services:{context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({title:{value:'Power Rangers'},overview:{value:'Container plot'},startDate:'1993-08-28',genres:['Action'],seasons:r.seasons.map(s=>({seasonNumber:s.number,name:{value:s.name},year:s.year}))}),resolveTmdbEpisodeSeasonMetadata:async()=>{throw Error('No gaps');}},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async args=>{assert.deepEqual(args.mappedSeasons,[24,25,28,29,30]);return {series:{poster:{it:{status:'available',selected:{url:'container.jpg'}}}},seasons:{1:{},24:{},25:{},28:{},29:{},30:{}}};}}}});
 assert.equal(out.info.synopsis,'Container plot');assert.equal(out.info.year,1993);assert.equal(out.info.poster,'container.jpg');assert.deepEqual(Object.keys(out.artworkLibrary.tmdb.seasons),['24','25','28','29','30']);assert.equal(out.enrichment.status,'ready');
});
test('episode overrides resolve original provider coordinates after season composition',()=>{
 const overrides=require('../episode-overrides.json'),key='streamingunity:9099';overrides[key]={tmdb:{id:2328,episodes:{'1:1':{season:24,episode:1,sourceTitle:'Episode 1',evidence:'Confirmed'}}}};
 try{const r=mergeGroup(group(power()).groups[0]),s=r.seasons[0],e=s.episodes[0];e.title='Translated title';assert.equal(require('../scripts/episode-identity').explicitTarget(r,s,e,'tmdb').season,24);}finally{delete overrides[key];}
});
test('merging confirmed groups preserves aliases and unrelated caches across repeated publications',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-composition-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source'),output=path.join(root,'out'),store=require('../../providers/streamingunity/scripts/store'),state=store.initialState();
 const entries=[...power(),entry(14220,1178532,'movie'),entry(36022,1178532,'movie'),entry(999999,999999,'movie')];
 for(const e of entries){e.record.seasonIndex=e.record.seasons.map(s=>({id:s.id,number:s.number}));state.known[e.record.id]={id:e.record.id,active:true};write(store.itemFile(source,e.record.id),e.record);}state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:entries.length};store.publish(source,state,{complete:true});
 const calls=[],options={roots:{streamingunity:source},selectedProviders:['streamingunity'],output,enrich:async r=>{calls.push(r.id);return {...r,enrichment:{status:'ready'}};}};
 const original=policy.decisions;try{policy.decisions=original.filter(r=>!r.catalog);await require('../scripts/pipeline').run({...options,now:1});}finally{policy.decisions=original;}
 const before=read(path.join(output,'manifest.json')),registry=read(path.join(output,'registry.json')),unrelated=registry.members['streamingunity:999999'];calls.length=0;
 await require('../scripts/pipeline').run({...options,now:2});const after=read(path.join(output,'manifest.json'));assert.equal(after.activeCount,3);assert.equal(calls.length,2);assert.equal(after.itemHashes[unrelated],before.itemHashes[unrelated]);assert.equal(Object.keys(after.aliases).length,3);require('../scripts/verify').verify(output);
 calls.length=0;await require('../scripts/pipeline').run({...options,now:3});assert.equal(calls.length,0);assert.equal(read(path.join(output,'manifest.json')).activeCount,3);require('../scripts/verify').verify(output);
});

test('publication verification rejects a playback reference pointing at the wrong provider episode',()=>{
 const r=mergeGroup(group(power()).groups[0]),{verifyComposition}=require('../scripts/composition');verifyComposition(r);r.seasons[0].episodes[0].playbackSources[0].episodeId=-1;assert.throws(()=>verifyComposition(r),/Invalid composed playback/);
});
test('an unavailable preferred copy does not deactivate another available variant',()=>{
 const a=entry(14220,1178532,'movie'),b=entry(36022,1178532,'movie');b.record.active=false;const r=mergeGroup(group([a,b]).groups[0]);assert(r.active);assert.equal(r.providers.streamingunity.find(v=>v.id===36022).availability,'unavailable');assert.equal(r.providers.streamingunity.find(v=>v.id===14220).availability,'present');
});
