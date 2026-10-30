'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runBatch,scanArchive,scanFeed,scrapeRecord,recordDue,workStatus}=require('../scripts/pipeline');
const {initialState,read,write,itemFile,observe,publish,hash}=require('../scripts/store');
const {parseListing}=require('../scripts/parse');
const {verify}=require('../scripts/verify');
const f=require('./fixtures');
const NOW=Date.UTC(2026,9,30),HOUR=3600000;
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'animeworld-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const error=status=>Object.assign(new Error(`HTTP ${status}`),{status});
function fake(total=26){
  const calls=[];
  return {baseUrl:f.BASE,calls,
    async discover(){return {html:f.home,baseUrl:f.BASE,source:'pastebin',pastebin:'https://pastebin.com/raw/KgQ4jTy6'};},
    async get(value){calls.push(value);const u=new URL(value,f.BASE),page=Number(u.searchParams.get('page')||1);let html;
      if(u.pathname==='/az-list')html=f.listing(Array.from({length:Math.max(0,Math.min(25,total-(page-1)*25))},(_,i)=>(page-1)*25+i+1),{page,total});
      else if(['/newest','/updated'].includes(u.pathname))html=f.listing([total],{archive:false,token:u.pathname==='/updated'?'token-new':''});
      else if(u.pathname==='/schedule')html=f.schedule;
      else if(u.pathname.startsWith('/api/tooltip/'))html=f.tooltip(Number(u.pathname.split('/').pop()));
      else if(u.pathname.startsWith('/play/'))html=f.anime(Number(u.pathname.match(/title-(\d+)/)[1]));
      else throw new Error('Unexpected URL '+value);
      return {html,url:u.href};
    }};
}

test('a full build exceeds 100 records, resumes batches, and publishes coherent incremental exports',async t=>{
  const root=temp(t),client=fake(126);
  let r=await runBatch({root,client,mode:'full',now:NOW});
  assert.equal(r.available,50);assert.equal(r.expected,126);assert.equal(r.complete,false);verify(root);
  const since=read(path.join(root,'state.json')).full.since;
  r=await runBatch({root,client,now:NOW+1000});assert.equal(r.available,100);
  assert.equal(read(path.join(root,'state.json')).full.since,since);
  r=await runBatch({root,client,now:NOW+2000});assert.equal(r.available,126);assert.equal(r.complete,true);verify(root);
  const manifest=read(path.join(root,'manifest.json')),before=client.calls.length;
  r=await runBatch({root,client,now:NOW+3000});assert.equal(r.processed,0);assert.equal(client.calls.length,before);
  assert.deepEqual(read(path.join(root,'manifest.json')).itemHashes,manifest.itemHashes);
  assert.equal(read(path.join(root,'state.json')).full,undefined);
});

test('failed archive pagination retains membership and resumes the pending page',async t=>{
  const root=temp(t),state=initialState(),client=fake(),save=()=>write(path.join(root,'state.json'),state);
  observe(state,{...f.identity(99),title:'Saved'},NOW-1000);
  const get=client.get.bind(client);client.get=async value=>{if(value==='/az-list?page=2')throw error(503);return get(value);};
  await scanArchive(client,state,root,{pagesPerBatch:20,now:NOW,save});
  assert.equal(state.archive.scan.nextPage,2);assert.equal(state.known[99].active,true);assert.equal(state.known[99].missingScanAt,null);
  client.get=get;
  await scanArchive(client,state,root,{pagesPerBatch:20,now:NOW+2*HOUR,save});
  assert.equal(state.archive.total,26);assert.ok(state.known[99].missingScanAt);assert.equal(state.known[99].active,true);
});

test('final archive validation can fail and resume without fetching a nonexistent extra page',async t=>{
  const root=temp(t),state=initialState(),client=fake(1),save=()=>{};
  await scanArchive(client,state,root,{pagesPerBatch:1,now:NOW,save});
  assert.equal(state.archive.scan.nextPage,2);
  const get=client.get.bind(client);let fail=true;client.get=async value=>{if(fail){fail=false;throw error(503);}return get(value);};
  await scanArchive(client,state,root,{pagesPerBatch:2,now:NOW+1000,save});
  assert.equal(state.archive.scan.nextPage,2);
  await scanArchive(client,state,root,{pagesPerBatch:2,now:NOW+2*HOUR,save});
  assert.equal(state.archive.total,1);assert.ok(!client.calls.includes('/az-list?page=2'));
});

test('count changes invalidate the scan and never deactivate known titles',async t=>{
  const root=temp(t),state=initialState(),client=fake(26),save=()=>{};
  await scanArchive(client,state,root,{pagesPerBatch:1,now:NOW,save});
  const get=client.get.bind(client);client.get=async value=>value==='/az-list?page=2'?
    {html:f.listing([26,27],{page:2,total:27})}:get(value);
  await scanArchive(client,state,root,{pagesPerBatch:2,now:NOW+1000,save});
  assert.equal(state.archive.completedAt,undefined);assert.equal(state.archive.scan,undefined);
  assert.ok(Object.values(state.known).every(item=>item.active));assert.ok(state.errors.archive);
});

test('tooltip failure preserves page data, backs off, and retries only the unfinished task',async t=>{
  const root=temp(t),state=initialState(),client=fake(1);
  observe(state,{...f.identity(1),title:'Title'},NOW);const get=client.get.bind(client);
  client.get=async value=>value.includes('/tooltip/')?Promise.reject(error(503)):get(value);
  await scrapeRecord(client,state,root,1,NOW);
  assert.ok(read(itemFile(root,1)).info.title);assert.equal(state.records[1].tooltipAt,null);
  assert.equal(recordDue(state,1,NOW+1000),false);
  client.calls.length=0;client.get=get;
  await scrapeRecord(client,state,root,1,NOW+2*HOUR);
  assert.deepEqual(client.calls,['/api/tooltip/1']);assert.ok(state.records[1].tooltipAt);assert.equal(state.records[1].error,undefined);
});

test('removal requires archive absence plus both endpoints, retains data, and reactivation is durable',async t=>{
  const root=temp(t),state=initialState(),client=fake(1);
  observe(state,{...f.identity(1),title:'Title'},NOW);await scrapeRecord(client,state,root,1,NOW);
  const saved=read(itemFile(root,1));state.known[1].missingScanAt=NOW+1;
  const get=client.get.bind(client);client.get=async value=>value.startsWith('/play/')?Promise.reject(error(404)):get(value);
  await scrapeRecord(client,state,root,1,NOW+1000);assert.equal(state.known[1].active,true);
  client.get=async()=>{throw error(404);};await scrapeRecord(client,state,root,1,NOW+2*HOUR);
  assert.equal(state.known[1].active,false);assert.deepEqual(read(itemFile(root,1)),saved);
  publish(root,state,workStatus(state,NOW+2*HOUR),NOW+2*HOUR);assert.deepEqual(read(path.join(root,'catalog.json')),[]);
  observe(state,{...f.identity(1),title:'Title'},NOW+3*HOUR);assert.equal(state.known[1].forceRefresh,true);
  write(path.join(root,'state.json'),state);const resumed=read(path.join(root,'state.json'));
  assert.equal(recordDue(resumed,1,NOW+3*HOUR),true);
  client.get=get;await scrapeRecord(client,resumed,root,1,NOW+3*HOUR);
  assert.equal(resumed.known[1].forceRefresh,false);assert.equal(hash(read(itemFile(root,1))),hash(saved));
});

test('feed scans continue beyond one batch and keep the old watermark until reaching overlap',async()=>{
  const state=initialState();state.feeds.updated={checkedAt:NOW-3*HOUR,head:['1:old']};
  const client={baseUrl:f.BASE,async get(value){const page=Number(new URL(value,f.BASE).searchParams.get('page'));
    return {html:f.listing([page===7?1:100+page],{archive:false,page,pages:8,token:page===7?'old':'new'})};}};
  await scanFeed(client,state,'updated',{now:NOW,save:()=>{},pagesPerBatch:5});
  assert.equal(state.feeds.updated.scan.page,6);assert.deepEqual(state.feeds.updated.head,['1:old']);
  await scanFeed(client,state,'updated',{now:NOW+1000,save:()=>{},pagesPerBatch:5});
  assert.equal(state.feeds.updated.scan,undefined);assert.deepEqual(state.feeds.updated.head,['101:new']);
  assert.equal(state.known[106].forceRefresh,true);
});

test('archive metadata changes queue a refresh without feed/archive fingerprints fighting',()=>{
  const state=initialState(),card=parseListing(f.listing([1]),f.BASE,{archive:true}).cards[0];
  observe(state,card,NOW);state.known[1].forceRefresh=false;
  observe(state,{...card,synopsis:null},NOW+1,false,'updated');assert.equal(state.known[1].forceRefresh,false);
  observe(state,card,NOW+2);assert.equal(state.known[1].forceRefresh,false);
  observe(state,{...card,title:'Changed'},NOW+3);assert.equal(state.known[1].forceRefresh,true);
});

test('HTTP 200 missing-page templates only retire a title after a complete archive omission',async t=>{
  const root=temp(t),state=initialState(),client=fake(1);
  observe(state,{...f.identity(1),title:'Title'},NOW);await scrapeRecord(client,state,root,1,NOW);
  const saved=read(itemFile(root,1));state.known[1].forceRefresh=true;
  client.get=async value=>({html:value.startsWith('/play/')?f.shell('<title>AnimeWorld - Pagina non trovata</title>'):
    '<div class="inner"><div class="title"><h1></h1></div></div><a class="watch-now" href="/play/.">Watch</a>'});
  await scrapeRecord(client,state,root,1,NOW+1000);assert.equal(state.known[1].active,true);
  state.known[1].missingScanAt=NOW+2000;
  await scrapeRecord(client,state,root,1,NOW+2*HOUR);assert.equal(state.known[1].active,false);
  assert.deepEqual(read(itemFile(root,1)),saved);
});
