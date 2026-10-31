'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const f=require('./fixtures');
const {parseArchive,parseAnime,parseEpisode}=require('../scripts/parse');
const {Client,PASTEBIN,FALLBACK}=require('../scripts/http');
const {run,scanFeed,scanNewest}=require('../scripts/pipeline');
const {read,write,itemFile,observe}=require('../scripts/store');
const {verify}=require('../scripts/verify');
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'saturn-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('archive verifies full pagination, counts, identities and challenge responses',()=>{
  assert.equal(parseArchive(f.archive(),f.BASE).pages,5);
  assert.equal(parseArchive(f.archive(125,5),f.BASE,5).cards.length,5);
  assert.throws(()=>parseArchive(f.archive(125,2),f.BASE,1),/pagination/);
  assert.throws(()=>parseArchive('Challenge',f.BASE),/Invalid/);
  assert.throws(()=>parseArchive(f.archive().replace('/anime/test-00002','/anime/test-00001'),f.BASE),/pagination/);
});
test('all 1180 episodes retained, declared totals never fabricate episodes, empty inventory supported',()=>{
  const record=parseAnime(f.anime(1,1180,1300),f.BASE,{id:f.id(1)});
  assert.equal(record.episodes.length,1180);assert.equal(record.info.declaredEpisodeCount,1300);
  assert.equal(parseAnime(f.anime(1,0,12),f.BASE,{id:f.id(1)}).episodes.length,0);
  assert.equal(parseAnime(f.anime(1,0,12).replace('Episodi (0)','Nessun episodio disponibile'),f.BASE,{id:f.id(1)}).episodes.length,0);
  assert.deepEqual(record.sourceIds,{anilist:1,mal:1});
  assert.throws(()=>parseAnime(f.anime(1).replace('Episodi (1)','Episodi (2)'),f.BASE,{id:f.id(1)}),/inventory/);
});
test('domain-independent images, paths and episode SEO provenance',()=>{
  const origins={},record=parseAnime(f.anime(1),f.BASE,{id:f.id(1)},origins);
  const moved=parseAnime(f.anime(1).replaceAll('animesaturn.net','animesaturn.test').replaceAll('saturncdn.net','saturncdn.test'),
    'https://www.animesaturn.test',{id:f.id(1)},{});
  assert.deepEqual(record,moved);
  const episode=parseEpisode(f.episode(1),f.BASE,record,record.episodes[0],origins);
  assert.equal(episode.synopsis,null);assert.equal(episode.thumbnail,null);assert.equal(episode.publishedAt,'2026-01-01');
  assert.equal(episode.sourceMetadata.jsonLd.description,'Series SEO synopsis');
  assert.throws(()=>parseEpisode(f.episode(2),f.BASE,record,record.episodes[0]),/identity/);
});
test('Pastebin, fallback, cookies, and WARP guard',async()=>{
  const calls=[];
  const client=new Client({delay:0,wait:async()=>{},guard:()=>{},transport:async request=>{
    calls.push(request);return {status:200,headers:{'set-cookie':['session=x; Path=/; Secure']},
      data:request.url===PASTEBIN?'https://www.animesaturn.test':request.url.includes('.test')?'Challenge':f.home};
  }});
  await client.discover();assert.equal(client.baseUrl,FALLBACK);
  await client.get('/az-list');assert.match(calls.at(-1).headers.Cookie,/session=x/);
  await client.get(PASTEBIN);assert(!calls.at(-1).headers.Cookie?.includes('other'));
  const guarded=new Client({guard:()=>{throw new Error('WARP_REQUIRED: disconnected');},transport:()=>{throw new Error('Network must not run');}});
  await assert.rejects(()=>guarded.get(FALLBACK),/WARP_REQUIRED/);
});
test('complete build exceeds 100 records and resumes archive without duplication',async t=>{
  const root=temp(t),client=f.client();
  await run({root,client,requestLimit:300,pagesPerBatch:5});
  const result=await run({root,client,requestLimit:300,pagesPerBatch:5});
  assert.equal(result.complete,true);assert.equal(verify(root).count,125);
});
test('episode checkpoint resumes inside a long title without refetching successful pages',async t=>{
  const root=temp(t),client=f.client(1,4);
  await run({root,client,requestLimit:2});assert.equal(read(itemFile(root,'00001')).episodes.filter(value=>value.sourceMetadata).length,1);
  await run({root,client,requestLimit:3});assert.equal(verify(root).complete,true);
  assert.equal(client.calls.filter(value=>value==='/anime/test-00001').length,1);
  assert.equal(client.calls.filter(value=>value==='/episode/test-00001/ep-1').length,1);
});
test('failed episodes retain progress, respect backoff and retry only missing metadata',async t=>{
  const root=temp(t),client=f.client(1,2),get=client.get.bind(client);let fail=true;
  client.get=async url=>{if(url.endsWith('/ep-2')&&fail)throw new Error('Temporary network error');return get(url);};
  await run({root,client,now:100000});const before=client.calls.length;
  await run({root,client,now:100001});assert.equal(client.calls.length,before);
  fail=false;await run({root,client,now:4000000});assert.equal(verify(root).complete,true);
  assert.equal(client.calls.filter(value=>value.endsWith('/ep-1')).length,1);
});
test('deactivation requires two complete archive omissions and separate confirmed HTTP failures',async t=>{
  const root=temp(t),client=f.client(1);await run({root,client,now:100000});
  const file=path.join(root,'state.json'),state=read(file);
  state.known['00001'].missingScans=1;state.archive.completedAt=200000;write(file,state);
  const missing=f.client(1);missing.get=async()=>{const error=new Error('HTTP 404');error.status=404;throw error;};
  await run({root,client:missing,stage:'details',now:300000});assert.equal(read(file).known['00001'].active,true);
  const next=read(file);next.known['00001'].missingScans=2;next.archive.completedAt=5000000;write(file,next);
  await run({root,client:missing,stage:'details',now:6000000});assert.equal(read(file).known['00001'].active,false);
  assert(fs.existsSync(itemFile(root,'00001')));assert.equal(verify(root).count,0);
  const restored=read(file);observe(restored,{id:'00001',path:f.route(1),title:'Test 1'},7000000);write(file,restored);
  const returning=f.client(1);await run({root,client:returning,stage:'details',now:7000000});
  assert.equal(verify(root).count,1);assert.equal(returning.calls.filter(value=>value.startsWith('/episode/')).length,0);
});
test('429 obeys Retry-After and retry attempts are bounded',async()=>{
  let requests=0;const delays=[];
  const client=new Client({delay:0,guard:()=>{},wait:async ms=>delays.push(ms),transport:async()=>{
    requests++;return {status:requests===1?429:200,headers:{'retry-after':'2'},data:f.home};
  }});
  await client.get(f.BASE);assert.equal(requests,2);assert.equal(delays[0],2000);
  const failing=new Client({delay:0,guard:()=>{},wait:async()=>{},transport:async()=>({status:503,headers:{},data:'Unavailable'})});
  await assert.rejects(()=>failing.get(f.BASE),/HTTP 503/);assert.equal(failing.requests,3);
});
test('interrupted archive scan preserves known membership and its page cursor',async t=>{
  const root=temp(t),client=f.client(31),get=client.get.bind(client);
  client.get=async url=>{if(url==='/az-list/2'){const error=new Error('HTTP 503');error.status=503;throw error;}return get(url);};
  await run({root,client,stage:'discover',pagesPerBatch:2,now:100000});
  const state=read(path.join(root,'state.json'));
  assert.equal(state.archive.scan.next,2);assert(Object.values(state.known).every(value=>value.active));
  client.get=get;await run({root,client,stage:'discover',pagesPerBatch:2,now:4000000});
  assert.equal(read(path.join(root,'state.json')).archive.total,31);
});
test('feed and newest scans preserve old heads until their previous boundary is found',async()=>{
  const state={known:{},origins:{},errors:{},feed:{head:['/episode/test-00001/ep-1']},newest:{head:['00031']}};
  const client={baseUrl:f.BASE,async get(url){
    if(url.startsWith('/newest'))return {html:f.archive(31,Number(url.split('/')[2])||1,'Nuove aggiunte')};
    const page=Number(new URL(url,f.BASE).searchParams.get('page'));
    return {html:JSON.stringify({page,pages:2,total:2,hasNext:page===1,items:[{url:`/episode/test-${page===1?'00002':'00001'}/ep-1`,title:'Test',episodeLabel:'1'}]})};
  }};
  await scanFeed(client,state,{now:100000,pagesPerBatch:1,save:()=>{}});
  assert.deepEqual(state.feed.head,['/episode/test-00001/ep-1']);assert.equal(state.feed.scan.page,2);
  await scanFeed(client,state,{now:100000,pagesPerBatch:1,save:()=>{}});
  assert.deepEqual(state.feed.head,['/episode/test-00002/ep-1']);assert(!state.feed.scan);
  await scanNewest(client,state,{now:100000,pagesPerBatch:1,save:()=>{}});
  assert.deepEqual(state.newest.head,['00031']);assert.equal(state.newest.scan.page,2);
  await scanNewest(client,state,{now:100000,pagesPerBatch:1,save:()=>{}});
  assert.equal(state.newest.head[0],'00001');assert(!state.newest.scan);
});

test('selective collection avoids per-episode requests but exclusive records still collect them',async t=>{
 const root=temp(t),store=require('../scripts/store'),state=store.initialState(),client=f.client(1,2),now=100;
 state.origins.site=f.BASE;observe(state,{id:f.id(1),path:f.route(1)},now);
 const sample=parseAnime(f.anime(1,2),f.BASE,state.known[f.id(1)],state.origins);
 client.coverage=require('../../../shared/catalog/tests/fixtures').coverageFor(sample,'animesaturn',root,now);
 await require('../scripts/pipeline').details(client,state,root,{now,requestLimit:20,save(){}});
 assert.equal(read(itemFile(root,f.id(1))).collection.mode,'linked');assert(!client.calls.some(p=>p.startsWith('/episode/')));
 client.coverage=null;require('../../../shared/catalog/collection').configure(client,'animesaturn',root,state,now+1);
 await require('../scripts/pipeline').details(client,state,root,{now:now+1,requestLimit:20,save(){}});
 assert.equal(read(itemFile(root,f.id(1))).collection.mode,'full');assert.equal(client.calls.filter(p=>p.startsWith('/episode/')).length,2);
});
