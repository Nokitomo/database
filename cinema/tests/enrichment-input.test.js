'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {read,write,hash}=require('../../shared/storage/json');
const {publish,loadSources}=require('../scripts/catalog');
const {run}=require('../scripts/pipeline');
const {verify}=require('../scripts/verify');
const store=require('../../providers/streamingunity/scripts/store');
function fixture(t,count=1){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-perf-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),state=store.initialState();
  state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:count};
  for(let id=1;id<=count;id++){
    state.known[id]={id,active:true};
    write(store.itemFile(source,id),{id,provider:'streamingunity',locale:'it',active:true,
      path:`/it/titles/${id}-title`,sourceIds:{tmdb_id:id},info:{id,name:`Title ${id}`,type:'movie'},images:[],seasonIndex:[],seasons:[]});
  }
  store.publish(source,state,{complete:true});
  return {source,options:{roots:{streamingunity:source},selectedProviders:['streamingunity'],output:path.join(root,'out'),now:1,
    enrich:async r=>({...r,enrichment:{status:'ready'}})}};
}

const inputs=require('../scripts/enrichment-input');
const {group,mergeGroup}=require('../scripts/catalog');
const corrections=require('../scripts/metadata-corrections');
const overrides=require('../episode-overrides.json');
function editSource(source,mutate){const r=read(store.itemFile(source,1));mutate(r);write(store.itemFile(source,1),r);const state=store.initialState();state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:1};state.known[1]={id:1,active:true};store.publish(source,state,{complete:true});}
function baselineInput(options){const src=loadSources(options.roots,options.selectedProviders),g=group(src.entries).groups[0];return inputs.input(corrections.applyMetadataCorrections(mergeGroup(g)),g.entries,overrides);}
function downgrade(options,raw){const file=path.join(options.output,'enriched/work-1.json'),cached=read(file),state=read(path.join(options.output,'state.json'));cached.fingerprint=hash(raw);delete cached.fingerprintVersion;state['work-1'].fingerprint=cached.fingerprint;write(file,cached);write(path.join(options.output,'state.json'),state);}
test('counter/date/actor-order changes update source info without external calls or loss of enriched fields',async t=>{
 const {source,options}=fixture(t);editSource(source,r=>Object.assign(r.info,{views:10,views_it:10,updated_at:'old',main_actors:[{id:1,name:'A'},{id:2,name:'B'}],translations:[{key:'views',locale:'it',value:'10'},{key:'plot',locale:'it',value:'plot'}]}));
 let calls=0;const enrich=async r=>{calls++;return {...r,info:{...r.info,runtime:42,cast:['External actor']},artworkLibrary:{tmdb:{kept:true}},enrichment:{status:'ready'}};};
 await run({...options,enrich});editSource(source,r=>{r.info.views=20;delete r.info.views_it;r.info.updated_at='new';r.info.main_actors.reverse();r.info.translations[0].value='20';});
 const result=await run({...options,enrich,now:2});assert.equal(calls,1);assert.equal(result.pendingCount,0);
 const r=read(path.join(options.output,'items/work-1.json'));assert.equal(r.info.views,20);assert(!Object.hasOwn(r.info,'views_it'));assert.equal(r.info.updated_at,'new');assert.equal(r.info.main_actors[0].id,2);assert.equal(r.info.runtime,42);assert.deepEqual(r.info.cast,['External actor']);assert(r.artworkLibrary.tmdb.kept);assert.equal(r.info.translations[0].value,'20');
});
test('legacy cache migrates across counter-only changes without resetting expiry or losing metadata',async t=>{
 const {source,options}=fixture(t);editSource(source,r=>Object.assign(r.info,{views:10,updated_at:'old'}));const raw=baselineInput(options);await run(options);downgrade(options,raw);
 const before=read(path.join(options.output,'state.json'))['work-1'].nextCheckAt;
 editSource(source,r=>Object.assign(r.info,{views:20,updated_at:'new'}));
 const result=await run({...options,now:2,enrich:async()=>{throw Error('Unexpected enrichment');}});assert.equal(result.processed,0);assert.equal(result.complete,true);assert.equal(read(path.join(options.output,'state.json'))['work-1'].nextCheckAt,before);assert.equal(read(path.join(options.output,'enriched/work-1.json')).fingerprintVersion,3);
 assert.equal((await run({...options,now:3})).processed,0);
});
test('migration retains errors, backoff and resumable partial progress',async t=>{
 const {source,options}=fixture(t);const raw=baselineInput(options);await run(options);downgrade(options,raw);
 const file=path.join(options.output,'state.json'),state=read(file);state['work-1'].error='Timeout';state['work-1'].nextCheckAt=100;write(file,state);
 write(path.join(options.output,'drafts/work-1.json'),{fingerprint:hash(raw),startedAt:1,progress:{saved:'keep'}});
 editSource(source,r=>r.info.views=20);let result=await run({...options,now:2});assert.equal(result.processed,0);assert.equal(result.pendingCount,1);assert.equal(read(file)['work-1'].error,'Timeout');
 result=await run({...options,now:101,enrich:async(r,{progress})=>{assert.equal(progress.saved,'keep');return {...r,enrichment:{status:'ready'}};}});assert.equal(result.processed,1);assert.equal(result.pendingCount,0);
});
test('semantic changes and expired periodic checks still enrich, and unknown legacy hashes fail closed',async t=>{
 for(const change of [r=>r.info.name='Changed',r=>r.info.release_date='2027-01-01',r=>r.info.score=8,r=>r.info.main_actors=[{id:5,name:'New actor'}],r=>r.sourceIds.tmdb_id=99]){
  const {source,options}=fixture(t);const raw=baselineInput(options);await run(options);downgrade(options,raw);editSource(source,change);assert.equal((await run({...options,now:2})).processed,1);
 }
 const {options}=fixture(t);await run(options);assert.equal((await run({...options,now:31*86400000})).processed,1);
 const file=path.join(options.output,'enriched/work-1.json'),cached=read(file);cached.fingerprint='unknown';delete cached.fingerprintVersion;write(file,cached);const stateFile=path.join(options.output,'state.json'),state=read(stateFile);state['work-1'].fingerprint='unknown';write(stateFile,state);assert.equal((await run({...options,now:32*86400000})).processed,1);
});
test('semantic comparison preserves artwork rank, episode data and policy changes',()=>{
 const raw={version:2,info:{name:'Title',main_actors:[{id:1},{id:2}],release_date:'2026'},seasons:[{number:1,images:[{id:1},{id:2}],episodes:[{number:1,title:'Corrected',thumbnail:null}]}],episodeOverrides:{a:{title:'Override'}},metadataPolicy:{providerArtworkOnly:true}};
 const equal=structuredClone(raw);equal.info.main_actors.reverse();equal.info.updated_at='new';assert.equal(hash(inputs.semantic(raw)),hash(inputs.semantic(equal)));
 for(const mutate of [r=>r.seasons[0].images.reverse(),r=>r.seasons[0].episodes[0].thumbnail='wrong',r=>r.episodeOverrides.a.title='New override',r=>r.metadataPolicy.providerArtworkOnly=false]){const changed=structuredClone(raw);mutate(changed);assert.notEqual(hash(inputs.semantic(raw)),hash(inputs.semantic(changed)));}
});
