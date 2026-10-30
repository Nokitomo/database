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
  const r=mergeGroup(group([entry('streamingunity',1)]).groups[0]);r.sourceIds.tvdb='20';r.seasons[0].episodes.push({number:3.5,title:'Episode 3.5',metadataSources:{}});
  const calls=[],progress={};
  const services={context:{},'tmdb/index.js':{resolveTmdbMediaMetadata:async()=>({overview:{value:'Series synopsis'}}),resolveTmdbEpisodeSeasonMetadata:async a=>{calls.push('tmdb');assert.equal(a.seasonNumber,0);assert.deepEqual(a.episodeNumbers,[1]);return {episodes:[{episodeNumber:1,title:{value:'TMDB title'},thumbnail:'tmdb.jpg'}]};}},
    'tvdb/index.js':{resolveTvdbEpisodeFallbacks:async a=>{calls.push('tvdb');assert.equal(a.seasonNumber,0);return [{episodeNumber:1,title:'Other',synopsis:'TVDB synopsis',thumbnail:'other.jpg'}];}},
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
  await assert.rejects(enrich(r,{services,progress}),/network/);assert(progress['tmdb:media']);assert(!progress['tmdb:artwork']);
  fail=false;await enrich(r,{services,progress});assert.equal(calls,1);
});
