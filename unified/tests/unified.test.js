'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {hash, write, read} = require('../../providers/animeworld/scripts/store');
const {hash: legacyHash} = require('../../providers/animeunity/scripts/lib');
const {compatible, groupEntries, baseRecord, loadSources} = require('../scripts/catalog');
const {enrichWorld} = require('../scripts/enrich');
const {run, worldInput} = require('../scripts/pipeline');
const {verify} = require('../scripts/verify');
const ready = async record=>({info:record.info,episodes:[],enrichment:{status:'ready'}});

test('missing membership without confirmed retirement remains unknown and active',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const aw=read(path.join(config.awRoot,'manifest.json'));delete aw.itemHashes['3'];
  write(path.join(config.awRoot,'manifest.json'),aw);await run({...config,enrich:ready});
  const item=read(path.join(config.output,'items/work-2.json'));
  assert.equal(item.active,true);assert.equal(item.availability.animeworld,'unknown');
  assert.equal(read(path.join(config.output,'manifest.json')).complete,false);
  assert.equal(verify(config.output).count,2);
});

test('retiring one provider preserves primary metadata and another provider availability',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const before=read(path.join(config.output,'items/work-1.json'));
  write(path.join(config.auRoot,'raw/index.json'),{expectedIds:[],inactiveIds:[1],baseUrl:'https://www.animeunity.co'});
  await run({...config,enrich:ready});
  const after=read(path.join(config.output,'items/work-1.json'));
  assert.equal(after.active,true);assert.equal(after.availability.animeunity,'unavailable');
  assert.equal(after.availability.animeworld,'present');
  for (const [key,value] of Object.entries(before.info)) assert.deepEqual(after.info[key],value);
  assert.deepEqual(after.providers.animeunity[0].episodes,before.providers.animeunity[0].episodes);
  assert.equal(verify(config.output).count,2);
});

test('legacy orphan item migrates to inactive hashed item and preserves origins',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const manifest=read(path.join(config.output,'manifest.json'));delete manifest.itemHashes['work-2'];manifest.schemaVersion=1;
  write(path.join(config.output,'manifest.json'),manifest);
  const aw=read(path.join(config.awRoot,'manifest.json'));delete aw.itemHashes['3'];aw.inactiveIds=[3];
  write(path.join(config.awRoot,'manifest.json'),aw);await run({...config,enrich:ready});
  const current=read(path.join(config.output,'manifest.json'));
  assert(current.itemHashes['work-2']);assert.equal(current.inactiveCount,1);
  assert.equal(read(path.join(config.output,'items/work-2.json')).active,false);
  assert.equal(verify(config.output).count,2);
  const hashes=current.itemHashes;await run({...config,enrich:ready});
  assert.deepEqual(read(path.join(config.output,'manifest.json')).itemHashes,hashes);
  assert.deepEqual(read(path.join(config.output,'changes.json')).deactivated,[]);
});

test('corrupt retained checkpoint aborts before publication',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const file=path.join(config.output,'items/work-2.json'),item=read(file);item.info.title='corrupt';write(file,item);
  await assert.rejects(run({...config,enrich:ready}),/Corrupt retained item/);
});

test('all providers can retire and reactivate without losing inventories or origins',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const aw=read(path.join(config.awRoot,'manifest.json'));
  write(path.join(config.auRoot,'raw/index.json'),{expectedIds:[],inactiveIds:[1],baseUrl:'https://www.animeunity.co'});
  write(path.join(config.awRoot,'manifest.json'),{...aw,itemHashes:{},inactiveIds:[2,3]});
  await run({...config,enrich:ready});
  const m=read(path.join(config.output,'manifest.json'));
  assert.equal(m.activeCount,0);assert.equal(m.inactiveCount,2);
  assert.equal(read(path.join(config.output,'items/work-1.json')).providers.animeunity[0].availability,'unavailable');
  assert.equal(verify(config.output).count,2);
  write(path.join(config.awRoot,'manifest.json'),aw);await run({...config,enrich:ready});
  assert.equal(read(path.join(config.output,'manifest.json')).activeCount,2);
  assert.equal(read(path.join(config.output,'items/work-1.json')).availability.animeunity,'unavailable');
  assert.equal(verify(config.output).count,2);
});

test('reassigned variants do not keep old identities falsely available',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const old=read(path.join(config.output,'items/work-2.json'));
  old.id='work-99';write(path.join(config.output,'items/work-99.json'),old);
  await run({...config,enrich:ready});
  const retired=read(path.join(config.output,'items/work-99.json'));
  assert.equal(retired.active,false);assert.equal(retired.providers.animeworld[0].availability,'reassigned');
  assert.equal(verify(config.output).count,3);
});

test('verification rejects an active flag inconsistent with provider status',async t=>{
  const config=fixture(t);await run({...config,enrich:ready});
  const file=path.join(config.output,'items/work-2.json'),item=read(file);item.active=false;write(file,item);
  const m=read(path.join(config.output,'manifest.json'));m.itemHashes[item.id]=hash(item);write(path.join(config.output,'manifest.json'),m);
  assert.throws(()=>verify(config.output),/active membership/);
});
const anime = (id, anilist, mal = null) => ({id, path: `/play/test.${id}`, sourceIds: {anilist, mal},
  info: {title: `Anime ${id}`, type: 'TV'}, images: [{kind: 'poster', url: {base: 'img', path: '/cover.jpg'}}], episodes: []});
const entry = (provider, record, enriched = false) => ({provider, id: record.id, record, enriched});
test('IDs match conservatively, never by episode count or title', () => {
  assert(compatible(anime(1,2,3), anime(9,2,3)));
  assert(!compatible(anime(1,2,3), anime(9,2,4)));
  assert(!compatible(anime(1,null), anime(1,null)));
});
test('variants retained, conflicts isolated and artwork origins namespaced', () => {
  const {groups, conflicts} = groupEntries([entry('animeunity', anime(1,2,3), true),
    entry('animeunity', anime(2,2,3), true), entry('animeworld', anime(1,2,3)), entry('animeworld', anime(5,2,4))]);
  assert.equal(groups.length,2); assert.equal(conflicts.length,1);
  const record = baseRecord(groups[0]);
  assert.equal(record.providers.animeunity.length,2);
  assert.equal(record.providers.animeworld.length,1);
  assert.equal(record.providerImages.animeworld[0].url.base,'animeworld:img');
});
test('canonical ID survives arrival on AnimeUnity and temporarily missing membership', () => {
  const first = groupEntries([entry('animeworld',anime(4,12))]);
  const next = groupEntries([entry('animeunity',anime(8,12)),entry('animeworld',anime(4,12))], first.registry);
  assert.equal(next.groups[0].id,first.groups[0].id);
  const last = groupEntries([entry('animeunity',anime(8,12))],next.registry);
  assert.equal(last.groups[0].id,first.groups[0].id);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'unified-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config = {auRoot:path.join(root,'au'),awRoot:path.join(root,'aw'),output:path.join(root,'out')};
  const au = anime(1,10), aw = [anime(2,10),anime(3,20)];
  write(path.join(config.auRoot,'raw/index.json'),{expectedIds:[1],baseUrl:'https://www.animeunity.co'});
  write(path.join(config.auRoot,'raw/items/1.json'),au);
  write(path.join(config.auRoot,'final/items/1.json'),au);
  write(path.join(config.auRoot,'final/manifest.json'),{complete:true,itemHashes:{1:legacyHash(au)}});
  for (const item of aw) write(path.join(config.awRoot,`items/${item.id}.json`),item);
  write(path.join(config.awRoot,'manifest.json'),{complete:true,origins:{site:'https://www.animeworld.ac',img:'https://img.animeworld.ac'},itemHashes:Object.fromEntries(aw.map(value=>[value.id,hash(value)]))});
  return config;
}

function topSnapshot(config,sourceIds={}){
  const store=require('../../providers/animetop/scripts/store'),root=path.join(path.dirname(config.output),'animetop'),s=store.initialState();
  const episodes=[1,2].map(season=>({id:`101:${season}:1`,path:'/anime-e-cartoni/test/',number:1,seasonNumber:season,title:'Provider title',metadataMappingStatus:'unresolved'}));
  const r={id:101,provider:'animetop',locale:'it',active:true,path:'/anime-e-cartoni/test/',sourceIds,
    info:{name:'AnimeTop title',title:'AnimeTop title',type:'TV',synopsis:'Original plot',poster:{base:'site',path:'/poster.jpg'}},images:[{role:'poster',reference:{base:'site',path:'/poster.jpg'}}],episodes,
    seasons:episodes.map(e=>({id:e.seasonNumber,number:e.seasonNumber,episodes:[e]})),seasonIndex:[{id:1,number:1},{id:2,number:2}],sourceRows:[],playback:[{reference:{url:'https://host.invalid/movie'}}],warnings:[]};
  store.observe(s,{id:101,path:r.path,name:r.info.title,kind:'tv_show'},1);s.origins={site:'https://animetop.net'};s.archive={completedAt:1,total:1};
  write(store.itemFile(root,101),r);store.publish(root,s,{complete:true});config.additionalSources={animetop:root};return {store,root,state:s,record:r};
}

test('AnimeTop optional snapshot preserves existing catalog and direct IDs merge without overriding AU',async t=>{
  const config=fixture(t);config.additionalSources={animetop:path.join(path.dirname(config.output),'missing')};await run({...config,enrich:ready});
  topSnapshot(config,{anilistId:10});const r=await run({...config,enrich:ready});assert.equal(r.count,2);
  const item=read(path.join(config.output,'items/work-1.json'));assert.equal(item.metadataProvider,'animeunity');assert.equal(item.providers.animetop.length,1);assert.equal(item.providers.animetop[0].seasons.length,2);assert.equal(item.providerImages.animetop[0].url.base,'animetop:site');assert.equal(item.providers.animetop[0].playback[0].reference.url,'https://host.invalid/movie');verify(config.output);
});
test('AnimeTop without direct IDs stays separate, keeps seasons and never requests guessed mappings',async t=>{
  const config=fixture(t);topSnapshot(config);let topCalls=0;
  const r=await run({...config,enrich:async input=>{if(input.provider!=='animetop')return ready(input);topCalls++;assert.equal(input.episodes.length,2);return enrichWorld(input,{providerRoot:'missing-build-must-not-be-used'});}});
  assert.equal(r.count,3);assert.equal(topCalls,1);const all=Object.keys(read(path.join(config.output,'manifest.json')).itemHashes).map(id=>read(path.join(config.output,'items',id+'.json'))),item=all.find(r=>r.metadataProvider==='animetop');
  assert.equal(item.enrichment.status,'unmapped');assert.equal(item.episodes.length,2);assert.equal(item.info.poster.base,'animetop:site');assert(item.episodes.every(e=>e.metadataMappingStatus==='unresolved'));verify(config.output);
});
test('AnimeTop source metadata updates invalidate source-only cache, and retirement retains original data',async t=>{
  const config=fixture(t),top=topSnapshot(config);const enrich=input=>input.provider==='animetop'?enrichWorld(input,{}):ready(input);await run({...config,enrich});
  top.record.info.synopsis='Updated plot';write(top.store.itemFile(top.root,101),top.record);top.store.publish(top.root,top.state,{complete:true});await run({...config,enrich});
  const registry=read(path.join(config.output,'registry.json')),id=registry.members['animetop:101'];assert.equal(read(path.join(config.output,'items',id+'.json')).info.synopsis,'Updated plot');
  top.state.known[101].active=false;top.store.publish(top.root,top.state,{complete:true});await run({...config,enrich});const r=read(path.join(config.output,'items',id+'.json'));assert.equal(r.active,false);assert.equal(r.providers.animetop[0].availability,'unavailable');assert.equal(r.providers.animetop[0].seasons.length,2);verify(config.output);
});
test('AnimeTop explicit unresolved numbering never enters AniBridge episode mapping even with direct identity',async()=>{
  const r={provider:'animetop',id:1,sourceIds:{anilistId:10},info:{title:'Test',type:'TV'},episodes:[{id:'1:2:1',number:1,path:'/x/',title:'Source',metadataMappingStatus:'unresolved'}]};
  const result=await enrichWorld(r,{services:{context:{},skipAniZip:true,'mappings/index.js':{resolveAnimeMappings:async()=>({schemaVersion:'3',targets:[],metadataTargets:[]}),buildAniBridgeExtra:()=>({}),resolveAniBridgeEpisodeMappings:()=>assert.fail('unsafe mapping')},'tmdb/index.js':{},fillGaps:async()=>{},artwork:async()=>({})}});
  assert.equal(result.episodes[0].metadataMappingStatus,'unresolved');assert.equal(result.episodes[0].title,'Source');
});
test('merge, enrichment, no-op rerun and manifest verification', async t => {
  const config=fixture(t); let calls=0;
  const enrich=async record=>{calls++;return {info:record.info,episodes:[],enrichment:{status:'ready'}};};
  const first=await run({...config,enrich}); assert.equal(first.count,2); assert.equal(calls,1);
  const before=read(path.join(config.output,'manifest.json')).itemHashes;
  await run({...config,enrich});assert.equal(calls,1);
  assert.deepEqual(read(path.join(config.output,'manifest.json')).itemHashes,before);
  assert.equal(verify(config.output).count,2);
});
test('source corruption blocks publication',t=>{
  const config=fixture(t);write(path.join(config.awRoot,'items/2.json'),anime(2,999));
  assert.throws(()=>loadSources(config.auRoot,config.awRoot),/hash mismatch/);
});
test('failure is retried after backoff, successful output reused',async t=>{
  const config=fixture(t);let calls=0, time=100000000;
  const enrich=async()=>{calls++;throw new Error('timeout');};
  await run({...config,enrich,now:()=>time});await run({...config,enrich,now:()=>time});
  assert.equal(calls,1);time+=3600001;
  await run({...config,enrich,now:()=>time});assert.equal(calls,2);
});
test('batch limit retains work for continuation',async t=>{
  const config=fixture(t);
  const result=await run({...config,limit:0});assert.equal(result.hasImmediateWork,true);
  assert.equal(result.pendingCount,1);assert.equal(verify(config.output).count,2);
});
test('raw AnimeUnity membership prevents duplicate external enrichment',async t=>{
  const config=fixture(t);fs.unlinkSync(path.join(config.auRoot,'final/items/1.json'));
  write(path.join(config.auRoot,'final/manifest.json'),{complete:false,itemHashes:{}});
  let calls=0;await run({...config,enrich:async record=>{calls++;return {info:record.info,enrichment:{status:'ready'}};}});
  assert.equal(calls,1);
});
test('external adapter groups season calls and fills TVDB fields modularly',async()=>{
  const record=anime(1,10);record.episodes=[1,2].map(id=>({id,number:String(id),path:`/play/x/${id}`}));
  let seasonCalls=0;
  const resolution={schemaVersion:'3',targets:[{provider:'tmdb_show',id:'7'}],metadataTargets:[]};
  const result=await enrichWorld(record,{services:{
    skipAniZip:true,
    context:{externalStatus:{tmdbWeb:{transientFailures:0}}},
    'mappings/index.js':{resolveAnimeMappings:async()=>resolution,buildAniBridgeExtra:()=>({mappings:{targets:resolution.targets}}),
      resolveAniBridgeEpisodeMappings:(_,number)=>({mappings:[{provider:'tmdb_show',id:'7',seasonNumber:1,episodeNumbers:[number]}]})},
    'tmdb/index.js':{resolveTmdbEpisodeSeasonMetadata:async()=>{seasonCalls++;return {episodes:[{episodeNumber:1,title:{value:'Titolo'},thumbnail:'https://image.tmdb.org/a.jpg'}]};}},
    fillGaps:async(_,context,episodes)=>{const item=episodes.get('1');item.synopsis ||= 'Sinossi TVDB';},
    artwork:async()=>({poster:[],background:[],logo:[]})
  }});
  assert.equal(seasonCalls,1);assert.equal(result.episodes[0].title,'Titolo');
  assert.equal(result.episodes[0].synopsis,'Sinossi TVDB');assert.equal(result.episodes.length,2);
});
test('workflows never trigger on push and publish only their data branch',()=>{
  const yaml=fs.readFileSync(path.join(__dirname,'../../.github/workflows/update-unified.yml'),'utf8');
  assert(!/^\s+push:/m.test(yaml));assert.match(yaml,/WARP_REQUIRED: '1'/);
  const shell=fs.readFileSync(path.join(__dirname,'../scripts/run-workflow.sh'),'utf8');
  assert.match(shell,/branch=unified-data/);assert(!/git push\s*$/m.test(shell));
});
test('AnimeWorld variants enrich the union of actual episodes',()=>{
  const a=anime(1,10),b=anime(2,10);
  a.episodes=[{id:11,number:'1'}];b.episodes=[{id:21,number:'1'},{id:22,number:'2'}];
  const input=worldInput({entries:[entry('animeworld',a),entry('animeworld',b)]});
  assert.deepEqual(input.episodes.map(value=>value.number),['1','2']);
  assert.equal(input.episodes[0].id,21);
});
test('different formats are not silently merged',()=>{
  const movie=anime(1,2),series=anime(2,2);movie.info.type='Movie';
  const result=groupEntries([entry('animeunity',movie),entry('animeworld',series)]);
  assert.equal(result.groups.length,2);assert.equal(result.conflicts.length,1);
});
test('deactivation retains hashed metadata and reactivation reuses identity',async t=>{
  const config=fixture(t);const enrich=async record=>({info:record.info,episodes:[],enrichment:{status:'ready'}});
  await run({...config,enrich});const first=read(path.join(config.output,'manifest.json'));
  const aw=read(path.join(config.awRoot,'manifest.json'));const saved=aw.itemHashes['3'];delete aw.itemHashes['3'];aw.inactiveIds=[3];
  write(path.join(config.awRoot,'manifest.json'),aw);await run({...config,enrich});
  const changes=read(path.join(config.output,'changes.json'));assert.deepEqual(changes.removed,[]);
  const removed=changes.deactivated;assert.equal(removed.length,1);
  const dormant=read(path.join(config.output,`items/${removed[0]}.json`));assert.equal(dormant.active,false);
  assert.equal(dormant.availability.animeworld,'unavailable');
  assert.equal(verify(config.output).count,2);
  assert(fs.existsSync(path.join(config.output,`items/${removed[0]}.json`)));
  aw.itemHashes['3']=saved;aw.inactiveIds=[];write(path.join(config.awRoot,'manifest.json'),aw);
  await run({...config,enrich:async()=>{throw new Error('Should reuse saved enrichment');}});
  assert.deepEqual(read(path.join(config.output,'manifest.json')).itemHashes,first.itemHashes);
});
test('image-only updates do not repeat external enrichment',async t=>{
  const config=fixture(t);let calls=0;
  const enrich=async record=>{calls++;return {info:record.info,episodes:[],enrichment:{status:'ready'}};};
  await run({...config,enrich});const record=read(path.join(config.awRoot,'items/3.json'));
  record.images.push({kind:'background',url:{base:'img',path:'/new.jpg'}});
  write(path.join(config.awRoot,'items/3.json'),record);
  const manifest=read(path.join(config.awRoot,'manifest.json'));manifest.itemHashes['3']=hash(record);write(path.join(config.awRoot,'manifest.json'),manifest);
  await run({...config,enrich});assert.equal(calls,1);
  assert.equal(verify(config.output).count,2);
});
test('AnimeSaturn shared membership preserves AU metadata; exclusive titles use external enrichment',async t=>{
  const config=fixture(t),saturn=path.join(config.awRoot,'../saturn');
  const shared={...anime('Ab123',10),provider:'animesaturn',images:[{kind:'poster',url:{base:'images',path:'/saturn.jpg'}}]};
  const exclusive={...anime('Xy999',777),provider:'animesaturn',images:[]};
  for(const record of [shared,exclusive])write(path.join(saturn,`items/${record.id}.json`),record);
  write(path.join(saturn,'manifest.json'),{provider:'animesaturn',complete:true,origins:{site:'https://www.animesaturn.net',images:'https://img.saturncdn.net'},
    itemHashes:{Ab123:hash(shared),Xy999:hash(exclusive)}});
  const calls=[];
  await run({...config,additionalSources:{animesaturn:saturn},enrich:async record=>{
    calls.push(`${record.provider}:${record.id}`);return {info:record.info,episodes:record.episodes,enrichment:{status:'ready'}};
  }});
  assert.deepEqual(calls.sort(),['animesaturn:Xy999','animeworld:3']);
  const registry=read(path.join(config.output,'registry.json'));
  const linked=read(path.join(config.output,`items/${registry.members['animeunity:1']}.json`));
  assert.equal(linked.metadataProvider,'animeunity');assert.equal(linked.info.title,'Anime 1');
  assert.equal(linked.providers.animesaturn[0].id,'Ab123');
  assert.equal(linked.providerImages.animesaturn[0].url.base,'animesaturn:images');
  const only=read(path.join(config.output,`items/${registry.members['animesaturn:Xy999']}.json`));
  assert.equal(only.metadataProvider,'animesaturn');assert.equal(only.providers.animeunity.length,0);
  assert.equal(verify(config.output).count,3);
  fs.unlinkSync(path.join(saturn,'manifest.json'));
  await assert.rejects(()=>run({...config,additionalSources:{animesaturn:saturn}}),/Missing animesaturn/);
});
test('an AnimeSaturn identity remains stable when it later appears on another provider',()=>{
  const first=groupEntries([entry('animesaturn',anime('Cd123',100))]);
  const next=groupEntries([entry('animeunity',anime(88,100)),entry('animesaturn',anime('Cd123',100))],first.registry);
  assert.equal(next.groups.length,1);assert.equal(next.groups[0].id,first.groups[0].id);
});
test('pending AnimeUnity source records normalize title_eng and plot for the consumer',()=>{
  const au=anime(1,2928);au.info={title:null,title_eng:'.hack//G.U. Returner',plot:'Trama',imageurl:'https://example.org/poster.jpg'};
  const result=baseRecord(groupEntries([entry('animeunity',au),entry('animesaturn',anime('8PrAP',2928))]).groups[0]);
  assert.equal(result.info.title,'.hack//G.U. Returner');assert.equal(result.info.synopsis,'Trama');
  assert.equal(result.enrichment.status,'pending');
});
