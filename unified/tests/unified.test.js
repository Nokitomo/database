'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {hash, write, read} = require('../../providers/animeworld/scripts/store');
const {hash: legacyHash} = require('../../scripts/lib');
const {compatible, groupEntries, baseRecord, loadSources} = require('../scripts/catalog');
const {enrichWorld} = require('../scripts/enrich');
const {run, worldInput} = require('../scripts/pipeline');
const {verify} = require('../scripts/verify');
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
test('deactivation removes only catalog membership and reactivation reuses identity',async t=>{
  const config=fixture(t);const enrich=async record=>({info:record.info,episodes:[],enrichment:{status:'ready'}});
  await run({...config,enrich});const first=read(path.join(config.output,'manifest.json'));
  const aw=read(path.join(config.awRoot,'manifest.json'));const saved=aw.itemHashes['3'];delete aw.itemHashes['3'];aw.inactiveIds=[3];
  write(path.join(config.awRoot,'manifest.json'),aw);await run({...config,enrich});
  const removed=read(path.join(config.output,'changes.json')).removed;assert.equal(removed.length,1);
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
