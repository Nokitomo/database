'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {group,mergeGroup,publish}=require('../scripts/catalog'),{enrich}=require('../scripts/enrich'),{verify}=require('../scripts/verify'),{run}=require('../scripts/pipeline');
const {write,read,hash}=require('../../shared/storage/json');
function entry(provider,id,tmdb=10,imdb='tt1234567',type='tv'){
 return {key:provider+':'+id,provider,record:{id,provider,locale:'it',active:true,path:provider==='streamingunity'?`/it/titles/${id}-x`:`/serie-tv/${id}-x-streaming.html`,info:{name:'Same title',type},sourceIds:{tmdb_id:tmdb,imdb_id:imdb},images:[],seasonIndex:[{id:0,number:0,episodes_count:1}],seasons:[{id:0,number:0,episodes:[{id:1,number:1,name:'Episode 1',plot:'',images:[]}]}]}};
}
function tmp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('external identity merges YAGA-like matches; title alone never merges; conflicting IDs stay apart',()=>{
  assert.equal(group([entry('streamingunity',1),entry('altadefinizione',2)]).groups.length,1);
  const c=group([entry('streamingunity',1),entry('altadefinizione',2,11)]);assert.equal(c.groups.length,2);assert.equal(c.conflicts.length,1);
  assert.equal(group([entry('streamingunity',1,null,null),entry('altadefinizione',2,null,null)]).groups.length,2);
  assert.equal(group([entry('streamingunity',1),entry('altadefinizione',2,10,'tt1234567','movie')]).groups.length,2);
});
test('provider arrival preserves canonical identity and fields fill independently',()=>{
  const su=entry('streamingunity',1),alta=entry('altadefinizione',2),first=group([su]);
  alta.record.seasons[0].episodes[0]={number:1,title:'Special title',plot:'Synopsis',still:{base:'images',path:'/still.jpg'}};
  const next=group([su,alta],first.registry);assert.equal(next.groups[0].id,first.groups[0].id);
  const r=mergeGroup(next.groups[0]),ep=r.seasons[0].episodes[0];assert.equal(ep.title,'Special title');assert.equal(ep.synopsis,'Synopsis');assert.equal(ep.thumbnail.base,'altadefinizione:images');
  assert.equal(r.providers.streamingunity[0].seasons[0].episodes[0].name,'Episode 1');
});
test('conflicting episode inventories are preserved per provider and not guessed',()=>{
  const su=entry('streamingunity',1),alta=entry('altadefinizione',2);alta.record.seasons[0].episodes.push({number:2,title:'Wrong numbering'});
  const r=mergeGroup(group([su,alta]).groups[0]);assert.equal(r.seasons[0].episodes.length,1);assert.equal(r.providers.altadefinizione[0].seasons[0].episodes.length,2);assert(r.warnings.length);
});
test('TMDB then TVDB fill fields modularly, retaining season zero and skipping fractions',async()=>{
  const r=mergeGroup(group([entry('streamingunity',1)]).groups[0]);r.sourceIds.tvdb='20';r.seasons[0].episodes[0].title='TMDB title';r.seasons[0].episodes.push({number:3.5,title:'Episode 3.5',metadataSources:{}});
  const calls=[],progress={};
  const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({overview:{value:'Series synopsis'}}),resolveTmdbEpisodeSeasonMetadata:async a=>{calls.push('tmdb');assert.equal(a.seasonNumber,0);assert.deepEqual(a.episodeNumbers,[]);return {episodes:[{episodeNumber:1,title:{value:'TMDB title'},thumbnail:'tmdb.jpg'}]};}},
    'tvdb/index.js':{resolveTvdbEpisodeFallbacks:async a=>{calls.push('tvdb');assert.equal(a.seasonNumber,0);return [{episodeNumber:1,title:'TMDB title',synopsis:'TVDB synopsis',thumbnail:'other.jpg'}];}},
    'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})},'tvdb/artworkLibrary.js':{resolveTvdbArtworkLibrary:async()=>({})}};
  let out=await enrich(r,{services,progress});assert.deepEqual(calls,['tmdb','tvdb']);assert.equal(out.seasons[0].episodes[0].title,'TMDB title');assert.equal(out.seasons[0].episodes[0].thumbnail,'tmdb.jpg');assert.equal(out.seasons[0].episodes[0].synopsis,'TVDB synopsis');assert.equal(out.seasons[0].episodes[1].synopsis,undefined);
  await enrich(r,{services,progress});assert.equal(calls.length,2);
});
test('source snapshots verified; publication retains inactive data and stable hashes',async t=>{
  const root=tmp(t),roots={};
  for(const provider of ['streamingunity','altadefinizione']){
    roots[provider]=path.join(root,provider);const store=require(`../../providers/${provider}/scripts/store`),state=store.initialState(),e=entry(provider,provider==='streamingunity'?1:2);
    e.record.info.id=e.record.id;
    state.known[e.record.id]={id:e.record.id,active:true};state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:1};write(store.itemFile(roots[provider],e.record.id),e.record);store.publish(roots[provider],state,{complete:true});
  }
  const output=path.join(root,'out');const ready=async r=>({...r,enrichment:{status:'ready'}});
  let out=await run({roots,output,enrich:ready,now:1});assert.equal(out.count,1);assert.equal(verify(output).complete,true);
  const before=read(path.join(output,'manifest.json')).itemHashes;await run({roots,output,enrich:ready,now:2});assert.deepEqual(read(path.join(output,'manifest.json')).itemHashes,before);
  const item=read(path.join(output,'items/work-1.json'));item.info.title='bad';write(path.join(output,'items/work-1.json'),item);
  await assert.rejects(run({roots,output,enrich:ready,now:3}),/Corrupt/);
});
test('absent provider variant stays unknown; confirmed inactive retains all metadata',t=>{
  const root=tmp(t),su=entry('streamingunity',1),alta=entry('altadefinizione',2),g=group([su,alta]);
  const source={snapshots:{streamingunity:{complete:true},altadefinizione:{complete:true}},origins:{}};
  publish(root,g.groups.map(mergeGroup),source,g.registry,[],{}, {pendingCount:0});
  const next=group([su],g.registry);publish(root,next.groups.map(mergeGroup),source,next.registry,[],{}, {pendingCount:0});
  const r=read(path.join(root,'items/work-1.json'));assert.equal(r.providers.altadefinizione[0].availability,'unknown');assert.equal(read(path.join(root,'manifest.json')).complete,false);
  su.record.active=false;alta.record.active=false;const inactive=group([su,alta],next.registry);publish(root,inactive.groups.map(mergeGroup),source,inactive.registry,[],{}, {pendingCount:0});
  assert.equal(verify(root).count,1);assert.equal(read(path.join(root,'catalog.json')).length,0);assert(read(path.join(root,'items/work-1.json')).seasons.length);
});
test('new workflows are manual/scheduled only, require WARP and isolate branches',()=>{
 for(const p of ['altadefinizione','cinema']){const y=fs.readFileSync(path.resolve(__dirname,`../../.github/workflows/update-${p}.yml`),'utf8');assert(y.includes('workflow_dispatch:'));assert(!/^\s+push:/m.test(y));assert(y.includes("WARP_REQUIRED: '1'"));}
});
test('failed external requests do not checkpoint success; successful phases resume',async()=>{
  const r=mergeGroup(group([entry('streamingunity',1)]).groups[0]),progress={};let calls=0,fail=true;
  const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>{calls++;return {overview:{value:'Plot'}};},resolveTmdbEpisodeSeasonMetadata:async()=>({episodes:[]})},'tvdb/index.js':{},
    'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>{if(fail)throw Error('network');return {};}}};
  const partial=await enrich(r,{services,progress,now:1});assert.equal(partial.enrichment.status,'retry');assert(progress['tmdb:media']);assert(!progress['tmdb:artwork']);
  fail=false;const resumed=await enrich(r,{services,progress,now:3600002});assert.equal(calls,1);assert.equal(resumed.enrichment.status,'ready');
});


test('source selection rejects unknown providers and supports streamingunity alone',async t=>{
 const {selectProviders}=require('../scripts/catalog');assert.deepEqual(selectProviders('streamingunity'),['streamingunity']);assert.throws(()=>selectProviders('bogus'));assert.throws(()=>selectProviders('streamingunity,streamingunity'));
 const root=tmp(t),source=path.join(root,'source'),store=require('../../providers/streamingunity/scripts/store'),state=store.initialState(),e=entry('streamingunity',1);
 e.record.info.id=1;state.known[1]={id:1,active:true};state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:1};write(store.itemFile(source,1),e.record);store.publish(source,state,{complete:true});
 const output=path.join(root,'out'),options={roots:{streamingunity:source},selectedProviders:['streamingunity'],output,enrich:async r=>({...r,enrichment:{status:'ready'}}),now:1};
 assert.equal((await run(options)).count,1);assert.equal(verify(output).complete,true);assert.deepEqual(read(path.join(output,'manifest.json')).selectedProviders,['streamingunity']);
 await assert.rejects(run({...options,selectedProviders:['streamingunity','filmez']}),/selection differs/);
});
test('episode identity rejects numbering-only, duplicates and shifted titles',()=>{
 const {confirmedMatch}=require('../scripts/episode-identity');const e={number:8,title:'Ape regina'},season={episodes:[e]},getTitle=v=>v.title,getNumber=v=>v.episodeNumber;
 assert.equal(confirmedMatch(e,season,[{episodeNumber:8,title:'Un altro episodio'}],getTitle,getNumber),null);
 assert.equal(confirmedMatch(e,season,[{episodeNumber:5,title:'Ape regina'}],getTitle,getNumber),null);
 assert.equal(confirmedMatch(e,season,[{episodeNumber:8,title:'Ape regina'},{episodeNumber:9,title:'Ape regina'}],getTitle,getNumber),null);
 assert(confirmedMatch(e,season,[{episodeNumber:8,title:'Ape regina'}],getTitle,getNumber));
});
test('complete provider episodes avoid external requests; wrong titles never fill gaps',async()=>{
 const r=mergeGroup(group([entry('streamingunity',1)]).groups[0]);const e=r.seasons[0].episodes[0];e.title='Provider title';e.synopsis='Provider plot';e.thumbnail='provider.jpg';let calls=0;
 const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:async()=>{calls++;return {episodes:[{episodeNumber:1,title:{value:'Wrong title'},overview:{value:'Wrong plot'},thumbnail:'wrong.jpg'}]};}},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}};
 let out=await enrich(r,{services});assert.equal(calls,0);assert.equal(out.seasons[0].episodes[0].thumbnail,'provider.jpg');
 e.thumbnail=null;out=await enrich(r,{services});assert.equal(calls,1);assert.equal(out.seasons[0].episodes[0].thumbnail,null);assert.equal(out.seasons[0].episodes[0].externalMappings.tmdb.status,'unverified');assert.equal(out.enrichment.status,'ready');
});

test('verified overrides cross seasons and reject stale source titles',async()=>{
 const overrides=require('../episode-overrides.json'),r=mergeGroup(group([entry('streamingunity',1)]).groups[0]);r.seasons[0].episodes[0].title='Ape regina';
 overrides['streamingunity:1']={tmdb:{id:10,episodes:{'0:1':{season:2,episode:5,sourceTitle:'Ape regina',evidence:'Manual verification'}}}};
 try{
 const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:async a=>{assert.equal(a.seasonNumber,2);return {episodes:[{episodeNumber:5,title:{value:'Queen Bee'},overview:{value:'Correct plot'},thumbnail:'correct.jpg'}]};}},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}};
 const out=await enrich(r,{services});const e=out.seasons[0].episodes[0];assert.equal(e.number,1);assert.equal(e.title,'Ape regina');assert.equal(e.synopsis,'Correct plot');assert.equal(e.externalMappings.tmdb.episode,5);
 r.seasons[0].episodes[0].title='Changed';await assert.rejects(enrich(r,{services}),/stale/);
 }finally{delete overrides['streamingunity:1'];}
});
test('Wikidata supplements missing IDs but never overrides conflicting provider identity',async()=>{
 const r=mergeGroup(group([entry('streamingunity',1)]).groups[0]);r.seasons=[];
 const services={context:{},'wikidata/index.js':{resolveWikidataExternalIds:async()=>({imdbId:'tt1234567',tvdbId:20,wikidataId:'Q1'})},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({})},'tvdb/index.js':{resolveTvdbMediaTextMetadata:async()=>({synopsis:'TVDB plot'})},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})},'tvdb/artworkLibrary.js':{resolveTvdbArtworkLibrary:async()=>({})}};
 const out=await enrich(r,{services});assert.equal(out.sourceIds.tvdb,'20');assert.equal(out.info.synopsis,'TVDB plot');
 services['wikidata/index.js'].resolveWikidataExternalIds=async()=>({imdbId:'tt9999999',tvdbId:30});const conflict=await enrich(r,{services});assert.equal(conflict.sourceIds.tvdb,null);assert(conflict.warnings.some(w=>w.reason==='wikidata-external-id-conflict'));
});


test('same-provider IDs produce review groups, including conflicts, without merging or blocking completion',t=>{
 const entries=[entry('streamingunity',1),entry('streamingunity',2),entry('streamingunity',3,11)],g=group(entries);
 assert.equal(g.groups.length,3);assert.equal(g.review.length,1);assert.equal(g.review[0].reason,'conflicting-external-ids');assert.equal(g.review[0].records.length,3);
 const root=tmp(t),source={snapshots:{streamingunity:{complete:true}},origins:{'streamingunity:site':'https://example.invalid'}};
 const m=publish(root,g.groups.map(mergeGroup),source,g.registry,g.conflicts,g.aliases,{pendingCount:0},g.review,g.splits);
 assert.equal(m.complete,true);assert.equal(m.pendingReviewCount,1);assert.equal(verify(root).count,3);
});
test('a third provider cannot bridge two distinct records from the same provider',()=>{
 const g=group([entry('streamingunity',1),entry('streamingunity',2),entry('altadefinizione',3)]);
 assert.equal(g.groups.length,2);for(const c of g.groups)assert.equal(new Set(c.entries.map(e=>e.provider)).size,c.entries.length);
});
test('manual identity corrections and reviewed decisions are durable and source-safe',()=>{
 const {applyCorrections}=require('../scripts/identity-policy'),a=entry('streamingunity',1),b=entry('streamingunity',2),policy={idCorrections:{},decisions:[{sources:[a.key,b.key],decision:'merge',reason:'User confirmed identical work'}]};
 assert.equal(group([a,b],undefined,policy).groups.length,1);assert.equal(group([a,b],undefined,policy).review[0].status,'reviewed');
 assert.throws(()=>group([a,entry('streamingunity',2,99)],undefined,policy),/Correct conflicting/);
 policy.decisions[0].decision='separate';assert.equal(group([a,b],undefined,policy).groups.length,2);
 policy.idCorrections[a.key]={ids:{tmdb:30,imdb:null},reason:'Verified external page'};const corrected=applyCorrections([a,b],policy);assert.equal(corrected[0].record.sourceIds.tmdb_id,30);assert.equal(a.record.sourceIds.tmdb_id,10);assert.equal(corrected[0].record.sourceIds.imdb_id,null);
 policy.idCorrections[a.key].ids.tmdb=-1;assert.throws(()=>applyCorrections([a],policy),/Invalid corrected/);
});
test('legacy pair and triple split once, discard merged enrichment, preserve unrelated caches and ownership',async t=>{
 const root=tmp(t),sourceRoot=path.join(root,'source'),output=path.join(root,'out'),store=require('../../providers/streamingunity/scripts/store'),state=store.initialState();
 state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:4};
 const entries=[entry('streamingunity',1),entry('streamingunity',2),entry('streamingunity',3),entry('streamingunity',4,40,'tt4444444')];
 for(const e of entries){e.record.info.id=e.record.id;state.known[e.record.id]={id:e.record.id,active:true};write(store.itemFile(sourceRoot,e.record.id),e.record);}store.publish(sourceRoot,state,{complete:true});
 const policy=require('../identity-overrides.json');policy.decisions.push({sources:entries.slice(0,3).map(e=>e.key),decision:'merge',reason:'Simulate old merged publication'});
 const calls=[],options={roots:{streamingunity:sourceRoot},selectedProviders:['streamingunity'],output,now:1,enrich:async r=>{calls.push(r.id);return {...r,info:{...r.info,marker:r.providers.streamingunity.length>1?'contaminated':'safe'},enrichment:{status:'ready'}};}};
 try{await run(options);}finally{policy.decisions.pop();}
 const oldRegistry=read(path.join(output,'registry.json')),unrelated=oldRegistry.members['streamingunity:4'],before=read(path.join(output,'items',unrelated+'.json'));calls.length=0;
 const result=await run({...options,now:2});assert.equal(result.count,4);assert.equal(calls.length,3);assert(!calls.includes(unrelated));assert.deepEqual(read(path.join(output,'items',unrelated+'.json')),before);
 const registry=read(path.join(output,'registry.json'));assert.equal(new Set(Object.values(registry.members)).size,4);assert.equal(registry.members['streamingunity:1'],oldRegistry.members['streamingunity:1']);
 for(const id of Object.values(registry.members)){const r=read(path.join(output,'items',id+'.json'));assert.equal(r.providers.streamingunity.length,1);assert.equal(r.info.marker,'safe');}
 assert.equal(read(path.join(output,'identity-migration.json')).splits.length,1);verify(output);calls.length=0;await run({...options,now:3});assert.equal(calls.length,0);assert.deepEqual(read(path.join(output,'registry.json')),registry);
});


test('all confirmed corrections preserve source records and typed playback identities',async()=>{
 const policy=require('../identity-overrides.json'),{applyCorrections}=require('../scripts/identity-policy');
 assert.equal(Object.keys(policy.idCorrections).length,35);
 for(const key of Object.keys(policy.idCorrections)){
  const id=Number(key.split(':')[1]),source=entry('streamingunity',id,999,'tt123', [11560,6914,5508,55440,7356,10323,4838].includes(id)?'tv':'movie');
  const before=structuredClone(source),corrected=applyCorrections([source],policy)[0];
  assert.deepEqual(source,before);assert.equal(corrected.record.info.type,before.record.info.type);
  assert.deepEqual(corrected.record.seasons,before.record.seasons);assert.equal(corrected.record.path,before.record.path);
  const record=mergeGroup(group([corrected]).groups[0]);
  assert.deepEqual(record.providers.streamingunity[0].identityCorrection.originalIds,before.record.sourceIds);
  if([11560,8643,22305].includes(id)){assert.equal(record.sourceIds.tmdb,null);assert(record.metadataPolicy.tmdb);}
 }
});

test('scoped TV metadata never replaces movie playback or imports unrelated episode/series identity',async()=>{
 const {applyCorrections}=require('../scripts/identity-policy');
 for(const id of [8643,22305]){
  const source=entry('streamingunity',id,999,'tt123','movie');source.record.seasons=[];
  const r=mergeGroup(group(applyCorrections([source],require('../identity-overrides.json'))).groups[0]);
  let media=0,wikidata=0,episodes=0;
  const out=await enrich(r,{services:{context:{},'wikidata/index.js':{resolveWikidataExternalIds:async()=>{wikidata++;}},'tvdb/index.js':{},
   'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>{media++;return {overview:{value:'WRONG SERIES PLOT'}};},resolveTmdbEpisodeSeasonMetadata:async a=>{episodes++;assert.equal(id,22305);assert.equal(a.mediaId,303267);assert.equal(a.seasonNumber,1);return {episodes:[{episodeNumber:1,overview:{value:'Correct episode plot'}}]};}},
   'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async a=>{assert.equal(a.type,'tv');return {id:a.id,seasons:{0:{},1:{},2:{}}};}}}});
  assert.equal(media,0);assert.equal(wikidata,0);assert.equal(episodes,id===22305?1:0);
  assert.equal(out.info.type,'movie');assert.equal(out.sourceIds.tmdb,null);assert.equal(out.sourceIds.imdb,'tt123');assert.deepEqual(out.seasons,[]);
  assert.deepEqual(Object.keys(out.artworkLibrary.tmdb.seasons),[id===8643?'2':'1']);assert.equal(out.enrichment.status,'ready');
 }
});

test('movie target for provider documentary preserves its one playable episode',async()=>{
 const {applyCorrections}=require('../scripts/identity-policy'),s=entry('streamingunity',11560);
 s.record.seasons=[{number:1,episodes:[{number:1,name:'Documentario',images:[]}]}];
 const r=mergeGroup(group(applyCorrections([s],require('../identity-overrides.json'))).groups[0]);
 const out=await enrich(r,{services:{context:{},'tvdb/index.js':{},'tmdb/index.js':{resolveTmdbMediaMetadata:async a=>{assert.equal(a.type,'movie');assert.equal(a.id,1433947);return {overview:{value:'Documentary plot'}};},resolveTmdbEpisodeSeasonMetadata:async()=>{throw Error('Must not query TV episodes');}},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}}});
 assert.equal(out.enrichment.status,'ready');assert.equal(out.info.type,'tv');assert.equal(out.seasons[0].episodes.length,1);assert.equal(out.seasons[0].episodes[0].externalMappings.tmdb.type,'movie');
});

test('source-only resolution and Peanuts do not guess episode mappings',async()=>{
 const {applyCorrections}=require('../scripts/identity-policy');
 for(const id of [4838,10323]){
  const r=mergeGroup(group(applyCorrections([entry('streamingunity',id)],require('../identity-overrides.json'))).groups[0]);
  let calls=0;
  const out=await enrich(r,{services:{context:{},'tvdb/index.js':{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>{calls++;return {};},resolveTmdbEpisodeSeasonMetadata:async()=>{throw Error('Episode request forbidden');}},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>{calls++;return {};}}}});
  assert.equal(out.enrichment.status,'ready');if(id===4838){assert.equal(calls,0);assert.equal(out.sourceIds.imdb,null);}else assert.equal(calls,2);
  assert.deepEqual(out.seasons,r.seasons);
 }
});

test('metadata-only policy change refreshes the affected record once and preserves unrelated caches',async t=>{
 const root=tmp(t),source=path.join(root,'source'),output=path.join(root,'out'),store=require('../../providers/streamingunity/scripts/store'),state=store.initialState();
 for(const id of [10323,999999]){const e=entry('streamingunity',id,id);e.record.info.id=id;state.known[id]={id,active:true};write(store.itemFile(source,id),e.record);}
 state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:2};store.publish(source,state,{complete:true});
 const policy=require('../identity-overrides.json'),rule=policy.idCorrections['streamingunity:10323'],metadata=rule.metadata;delete rule.metadata;
 const calls=[],options={roots:{streamingunity:source},selectedProviders:['streamingunity'],output,enrich:async r=>{calls.push(r.id);return {...r,enrichment:{status:'ready'}};}};
 try{await run({...options,now:1});}finally{rule.metadata=metadata;}
 const before=read(path.join(output,'manifest.json')).itemHashes;calls.length=0;
 await run({...options,now:2});assert.equal(calls.length,1);const changed=calls[0],after=read(path.join(output,'manifest.json')).itemHashes;
 for(const id of Object.keys(before))if(id!==changed)assert.equal(after[id],before[id]);
 calls.length=0;await run({...options,now:3});assert.equal(calls.length,0);assert.equal(verify(output).count,2);
});

test('confirmed parent IMDb seasons cannot merge through an unscoped third provider',()=>{
 const {applyCorrections}=require('../scripts/identity-policy'),policy=require('../identity-overrides.json');
 const entries=applyCorrections([entry('streamingunity',3368),entry('altadefinizione',900,null,'tt14668192')],policy);
 assert.equal(group(entries).groups.length,2);
 assert.deepEqual(entries[0].record.metadataPolicy.imdb,{id:'tt14668192',seasons:[2]});
});
test('confirmed episodes persist mappings even when every provider field is complete',async()=>{
 const r=mergeGroup(group([entry('streamingunity',3235,1600)]).groups[0]);
 const rule=require('../episode-overrides.json')['streamingunity:3235'].tmdb.episodes['3:10'];
 r.seasons=[{number:3,episodes:[{number:10,title:rule.sourceTitle,synopsis:'Provider plot',thumbnail:'provider.jpg'}]}];
 const out=await enrich(r,{services:{context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:async()=>{throw Error('No request needed');}},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}}});
 assert.equal(out.seasons[0].episodes[0].externalMappings.tmdb.episode,10);
 assert.equal(out.seasons[0].episodes[0].synopsis,'Provider plot');
});
test('Ned composite and Love Island reunion preserve provider episodes without external fallbacks',async()=>{
 for(const [id,tmdb,season,number]of [[3235,1600,3,21],[3355,127623,1,30]]){
 const r=mergeGroup(group([entry('streamingunity',id,tmdb)]).groups[0]),rule=require('../episode-overrides.json')['streamingunity:'+id].tmdb.episodes[season+':'+number];
 r.sourceIds.tvdb='123';r.seasons=[{number:season,episodes:[{number,title:rule.sourceTitle,synopsis:null,thumbnail:null}]}];
 const forbidden=async()=>{throw Error('Provider-only episode request forbidden');};
 const out=await enrich(r,{services:{context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:forbidden},'tvdb/index.js':{resolveTvdbEpisodeFallbacks:forbidden},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})},'tvdb/artworkLibrary.js':{resolveTvdbArtworkLibrary:async()=>({})}}});
 assert.equal(out.enrichment.status,'ready');assert.equal(out.seasons[0].episodes.length,1);assert.equal(out.seasons[0].episodes[0].thumbnail,null);
 if(id===3235)assert.deepEqual(out.seasons[0].episodes[0].externalMappings.tmdb.episodes,[21,22]);else assert.equal(out.seasons[0].episodes[0].externalMappings.tmdb.status,'provider-only');
 }
});
test('black and white edition never imports external artwork or episode thumbnails',async()=>{
 const {applyCorrections}=require('../scripts/identity-policy'),policy=require('../identity-overrides.json');
 const r=mergeGroup(group(applyCorrections([entry('streamingunity',59153)],policy)).groups[0]);
 const rule=require('../episode-overrides.json')['streamingunity:59153'].tmdb.episodes['1:1'];
 r.seasons=[{number:1,episodes:[{number:1,title:rule.sourceTitle,synopsis:null,thumbnail:null}]}];
 const out=await enrich(r,{previous:{artworkLibrary:{tmdb:{poster:'color.jpg'}}},services:{context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:async()=>({episodes:[{episodeNumber:1,overview:{value:'Text'},thumbnail:'color.jpg'}]})},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>{throw Error('Artwork forbidden');}}}});
 assert.deepEqual(out.artworkLibrary,{});assert.equal(out.seasons[0].episodes[0].thumbnail,null);assert.equal(out.seasons[0].episodes[0].synopsis,'Text');assert.equal(out.enrichment.status,'ready');
});
test('Primo Appuntamento refuses the Spanish IMDb even if rediscovered by Wikidata',async()=>{
 const {applyCorrections}=require('../scripts/identity-policy');const r=mergeGroup(group(applyCorrections([entry('streamingunity',3359)],require('../identity-overrides.json'))).groups[0]);
 const out=await enrich(r,{services:{context:{},'wikidata/index.js':{resolveWikidataExternalIds:async()=>({imdbId:'tt13232504'})},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({}),resolveTmdbEpisodeSeasonMetadata:async()=>{throw Error('Episode request forbidden');}},'tvdb/index.js':{},'tmdb/artworkLibrary.js':{resolveTmdbArtworkLibrary:async()=>({})}}});
 assert.equal(out.sourceIds.imdb,null);assert.equal(out.enrichment.status,'ready');
});
