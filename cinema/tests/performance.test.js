'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {read,write,hash}=require('../../shared/storage/json');
const {publish,loadSources}=require('../scripts/catalog');
const {run}=require('../scripts/pipeline');
const {verify}=require('../scripts/verify');
const store=require('../../providers/streamingunity/scripts/store');
function fixture(t,count=105){
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
test('source items are read once while item and shard integrity checks remain active',t=>{
  const {source,options}=fixture(t,3),original=fs.readFileSync,counts=new Map();
  t.mock.method(fs,'readFileSync',function(file,...args){const key=String(file);counts.set(key,(counts.get(key)||0)+1);return original.call(this,file,...args);});
  assert.equal(loadSources(options.roots,options.selectedProviders).entries.length,3);
  for(let id=1;id<=3;id++)assert.equal(counts.get(store.itemFile(source,id)),1);
  write(path.join(source,'shards/00.json'),[]);
  // If shard 00 is empty already, corrupt a populated shard instead.
  const m=read(path.join(source,'manifest.json')),key=Object.keys(m.shardHashes).find(k=>read(path.join(source,'shards',k+'.json')).length);
  write(path.join(source,'shards',key+'.json'),[]);
  assert.throws(()=>loadSources(options.roots,options.selectedProviders),/shard/i);
});
test('default batches exceed ten, checkpoint each title, and resume only remaining work',async t=>{
  const {options}=fixture(t);let calls=0;
  const enrich=async r=>{calls++;return options.enrich(r);};
  let result=await run({...options,enrich});
  assert.equal(result.processed,100);assert.equal(result.pendingCount,5);assert.equal(result.hasImmediateWork,true);
  assert.equal(Object.keys(read(path.join(options.output,'state.json'))).length,100);
  assert(result.timings.sourcesMs>=0&&result.timings.publicationMs>=0&&result.timings.totalMs>=0);
  assert.deepEqual(result.externalMetrics,{}); // Fake enrichment performs no HTTP/cache work.
  result=await run({...options,enrich,now:2});
  assert.equal(result.processed,5);assert.equal(calls,105);assert.equal(result.pendingCount,0);assert.equal(verify(options.output).complete,true);
  assert.equal((await run({...options,enrich,now:3})).processed,0);assert.equal(calls,105);
});
test('deadline stops new titles and explicit limits, merge mode, invalid limits remain safe',async t=>{
  const {options}=fixture(t,3);let clock=10000,calls=0;
  t.mock.method(Date,'now',()=>clock);
  const result=await run({...options,budgetMs:1050,enrich:async r=>{calls++;clock+=100;return options.enrich(r);}});
  assert.equal(result.processed,1);assert.equal(calls,1);assert.equal(result.hasImmediateWork,true);
  assert.equal((await run({...options,limit:1,now:2})).processed,1);
  assert.equal((await run({...options,stage:'merge',limit:0,budgetMs:0,now:3})).processed,0);
  for(const limit of [-1,0,NaN,Infinity,1.5])await assert.rejects(run({...options,limit}),/limits/);
  for(const budgetMs of [-1,0,999,1000,NaN,Infinity,1000.5])await assert.rejects(run({...options,budgetMs}),/limits/);
});
test('invalid all-mode configuration fails before source reads or output writes',async t=>{
  const {options}=fixture(t,1),original=fs.readFileSync,writes=[];
  t.mock.method(fs,'readFileSync',function(file,...args){
    assert(!String(file).startsWith(options.roots.streamingunity),'invalid configuration must not load sources');
    return original.call(this,file,...args);
  });
  t.mock.method(fs,'writeFileSync',file=>writes.push(file));
  for(const settings of [{limit:0},{budgetMs:0},{budgetMs:1000}]){
    await assert.rejects(run({...options,...settings}),/Invalid cinema batch limits/);
  }
  assert.equal(writes.length,0);assert.equal(fs.existsSync(options.output),false);
});
test('failed titles retain drafts and backoff, then resume saved phases',async t=>{
  const {options}=fixture(t,1);let calls=0;
  const enrich=async(r,{progress,save})=>{
    calls++;if(!progress.media){progress.media={plot:'durable'};save(progress);throw Error('transient');}
    assert.deepEqual(progress.media,{plot:'durable'});return options.enrich(r);
  };
  let result=await run({...options,enrich});assert.equal(result.pendingCount,1);
  assert.equal(read(path.join(options.output,'drafts/work-1.json')).progress.media.plot,'durable');
  assert.equal((await run({...options,enrich,now:2})).processed,0);assert.equal(calls,1);
  result=await run({...options,enrich,now:3600002});assert.equal(result.pendingCount,0);assert.equal(calls,2);
  assert.equal(read(path.join(options.output,'drafts/work-1.json')),null);verify(options.output);
});
test('unchanged records and shards are not rewritten; dirty shard hashes match actual contents',async t=>{
  const {options}=fixture(t,3);await run(options);
  const manifest=read(path.join(options.output,'manifest.json'));
  const before=fs.statSync(path.join(options.output,'coverage.json')).mtimeMs,writes=[],original=fs.writeFileSync;
  t.mock.method(fs,'writeFileSync',function(file,...args){writes.push(String(file).replace(/\\/g,'/'));return original.call(this,file,...args);});
  await run({...options,now:2});
  assert(!writes.some(p=>/\/(items|shards)\//.test(p)));assert.equal(fs.statSync(path.join(options.output,'coverage.json')).mtimeMs,before);
  assert.equal(read(path.join(options.output,'manifest.json')).coverageHash,manifest.coverageHash);
  // A new source field invalidates enrichment and affects just one shard.
  const state=store.initialState();state.origins={site:'https://example.invalid'};state.archive={completedAt:1,total:3};
  for(let id=1;id<=3;id++)state.known[id]={id,active:true};
  const file=store.itemFile(options.roots.streamingunity,1),r=read(file);r.info.name='Changed';write(file,r);store.publish(options.roots.streamingunity,state,{complete:true});
  writes.length=0;await run({...options,now:3});
  const shardWrites=writes.filter(p=>p.includes('/out/shards/'));assert.equal(shardWrites.length,1);assert(shardWrites[0].includes('/01.json.'));
  const next=read(path.join(options.output,'manifest.json'));
  for(const [key,expected]of Object.entries(next.shardHashes))assert.equal(hash(read(path.join(options.output,'shards',key+'.json'))),expected);
  verify(options.output);
});
test('skipped shards remain subject to verification; missing shards rebuild and retained corruption fails',async t=>{
  const {options}=fixture(t,1);await run(options);
  const shard=path.join(options.output,'shards/01.json');fs.unlinkSync(shard);await run({...options,now:2});verify(options.output);
  write(shard,[]);await run({...options,now:3});assert.throws(()=>verify(options.output),/shard/i);
  const file=path.join(options.output,'items/work-1.json'),r=read(file);r.info.title='corrupt';write(file,r);
  await assert.rejects(run({...options,now:4}),/Corrupt retained/);
});
test('coverage refreshes after one day and corrupt coverage cannot be silently reused',async t=>{
  const {options}=fixture(t,1);await run(options);
  const file=path.join(options.output,'coverage.json'),mfile=path.join(options.output,'manifest.json');
  const coverage=read(file),m=read(mfile);coverage.generatedAt=Date.now()-86400001;
  const {contentHash,...body}=coverage;coverage.contentHash=hash(body);write(file,coverage);m.coverageHash=coverage.contentHash;write(mfile,m);
  await run({...options,now:2});assert(read(file).generatedAt>coverage.generatedAt);verify(options.output);
  const corrupt=read(file);corrupt.entries=[];write(file,corrupt);
  await assert.rejects(run({...options,now:3}),/coverage/);
});
