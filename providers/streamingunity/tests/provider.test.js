'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Client,FALLBACK,COMMUNITY_FALLBACK}=require('../scripts/http');
const {archive,detail}=require('../scripts/parse');
const {scanArchive,scanFeed,collect,run}=require('../scripts/pipeline');
const {initialState,read,write,itemFile,observe}=require('../scripts/store');
const {verify}=require('../scripts/verify');
const base='https://streamingunity.fun';
test('provider slugs containing question marks remain a single URL path',()=>{
  const p=require('../scripts/urls').titlePath(6156,'Are-you-the-one-?-italia');
  assert.equal(new URL(p,base).search,'');assert(p.includes('%3F'));
});
const card=id=>({id,slug:'title-'+id,name:'Title '+id,type:'movie'});
const listing=(cards,total,page=1)=>JSON.stringify({data:cards,total,current_page:page,per_page:60,last_page:Math.max(1,Math.ceil(total/60))});
function page(id=1,seasons=[],number=undefined){return JSON.stringify({props:{cdn_url:'https://cdn.streamingunity.fun',title:{...card(id),type:seasons.length?'tv':'movie',seasons,tmdb_id:42,images:[{filename:'a.webp',type:'poster'}]},loadedSeason:number===undefined?null:{id:number+100,title_id:id,number,episodes:[{id:number+200,number:1,season_id:number+100,name:'Episode',plot:'Plot',images:[{filename:'e.webp'}]}]}}});}
function tmp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'streamingunity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('season zero checkpoints and resumes without renumbering zero or fractional episodes',async t=>{
  const root=tmp(t),state=initialState(),seasons=[{id:100,number:0,episodes_count:1},{id:101,number:1,episodes_count:1}];
  observe(state,card(1),1);const calls=[];
  const client={async get(url){calls.push(url);const number=url.endsWith('season-0')?0:url.endsWith('season-1')?1:undefined;
    const data=JSON.parse(page(1,seasons,number));if(number!==undefined)data.props.loadedSeason.episodes[0].number=number===0?0:3.5;
    return {html:JSON.stringify(data)};}};
  await collect(client,state,root,1,{now:100,save(){},maxSeasons:1});assert(!state.records[1]?.complete);
  await collect(client,state,root,1,{now:101,save(){},maxSeasons:1});
  const result=read(itemFile(root,1));assert.deepEqual(result.seasons.map(s=>s.number),[0,1]);
  assert.deepEqual(result.seasons.map(s=>s.episodes[0].number),[0,3.5]);
  assert.equal(calls.filter(p=>p.endsWith('season-0')).length,1);
});
test('archive rejects truncated inventories and wrong pagination',()=>{
  assert.equal(archive(listing([card(1)],1)).total,1);
  assert.throws(()=>archive(listing([],1)),/Incomplete/);
  assert.throws(()=>archive(listing([card(1)],1,2)),/pagination/);
  assert.throws(()=>archive('"Page limit reached (20)"'),/payload/);
});
test('partition scan exceeds 1200 records without ever requesting page 21',async()=>{
  const state=initialState();state.genres=[{id:1}];let calls=0;const now=Date.now();
  const client={async get(url){const u=new URL(url,base),p=Number(u.searchParams.get('page'));assert(p<=20);calls++;
    let count=1300,offset=0;if(u.searchParams.has('year')){count=650;offset=u.searchParams.get('year')==='2025'?650:0;}
    return {html:listing(Array.from({length:Math.min(60,Math.max(0,count-(p-1)*60))},(_,i)=>card(offset+(p-1)*60+i+1)),count,p)};}};
  for(let n=0;n<20&&!state.archive.completedAt;n++)await scanArchive(client,state,{now,save(){},maxRequests:3,minYear:2025,maxYear:2026});
  assert.equal(state.archive.total,1300);assert.equal(Object.keys(state.known).length,1300);assert(calls>20);
});
test('oversized year splits by media type',async()=>{
  const state=initialState();state.genres=[];const now=Date.now();
  const client={async get(url){const u=new URL(url,base),p=Number(u.searchParams.get('page'));assert(p<=20);const type=u.searchParams.get('type'),count=type?650:1300,offset=type==='tv'?650:0;return {html:listing(Array.from({length:Math.min(60,Math.max(0,count-(p-1)*60))},(_,i)=>card(offset+(p-1)*60+i+1)),count,p)};}};
  await scanArchive(client,state,{now,save(){},maxRequests:100,minYear:2026,maxYear:2026});assert.equal(state.archive.total,1300);
});
test('pre-2000 discovery uses decade-aligned partitions',async()=>{
  const state=initialState();const client={async get(){return {html:listing(Array.from({length:60},(_,i)=>card(i+1)),1300)};}};
  await scanArchive(client,state,{now:Date.now(),save(){},maxRequests:1,minYear:1990,maxYear:2001});
  assert.deepEqual(state.archive.scan.queue.map(t=>t.filters.year),['2001','2000','1990']);
});
test('oversized type partitions split by numeric genres and cover the union',async()=>{
  const state=initialState();state.genres=[{id:1},{id:2}];
  const client={async get(url){const q=new URL(url,base).searchParams,p=Number(q.get('page'));assert(p<=20);
    const type=q.get('type'),genre=q.get('genre[]'),count=genre?650:type?1300:2600;
    const offset=(type==='tv'?1300:0)+(genre==='2'?650:0);
    return {html:listing(Array.from({length:Math.min(60,Math.max(0,count-(p-1)*60))},(_,i)=>card(offset+(p-1)*60+i+1)),count,p)};}};
  await scanArchive(client,state,{now:Date.now(),save(){},maxRequests:100,minYear:2026,maxYear:2026});
  assert.equal(state.archive.total,2600);assert.equal(Object.keys(state.known).length,2600);
});
test('network interruption keeps cursor and no retirement; changed totals fail closed',async()=>{
  const state=initialState();observe(state,card(999),1);let fail=true;
  const client={async get(url){const p=Number(new URL(url,base).searchParams.get('page'));if(p===2&&fail)throw new Error('network');return {html:listing(Array.from({length:p===1?60:1},(_,i)=>card((p-1)*60+i+1)),61,p)};}};
  await assert.rejects(scanArchive(client,state,{now:100,save(){},maxRequests:5}),/network/);assert.equal(state.archive.scan.queue[0].page,2);assert.equal(state.known[999].missingScans,0);
  fail=false;await scanArchive(client,state,{now:100,save(){},maxRequests:5});assert.equal(state.known[999].missingScans,1);
});
test('sitemap candidates require IT archive membership',async()=>{
  const state=initialState(),now=Date.now();state.archive.scan={total:1,first:require('../scripts/store').hash([[1,'title-1']]),startedAt:now,ids:{},queue:[],candidates:[{id:2,slug:'title-2'},{id:1,slug:'title-1'}],candidateIndex:0};
  const client={async get(url){if(url.includes('/titles/'))return {html:page(url.includes('/2-')?2:1)};const u=new URL(url,base);return {html:listing(u.searchParams.get('search')==='Title 2'?[]:[card(1)],u.searchParams.get('search')==='Title 2'?0:1)};}};
  await scanArchive(client,state,{now,save(){},maxRequests:10});assert.equal(state.archive.total,1);assert(!state.known[2]);
});
test('missing coverage never claims success',async()=>{
  const state=initialState();state.archive.scan={total:10,queue:[],ids:{},candidates:[],candidateIndex:0};
  await assert.rejects(scanArchive({},state,{now:Date.now(),save(){}}),/coverage incomplete/);assert(!state.archive.completedAt);
});
test('global count changes reject otherwise complete scans',async()=>{
  const state=initialState();state.archive.scan={total:1,first:'old',ids:{1:true},queue:[],startedAt:1};
  const client={async get(){return {html:listing([card(1),card(2)],2)};}};
  await assert.rejects(scanArchive(client,state,{now:100,save(){}}),/changed/);assert(!state.archive.completedAt);
});
test('update gap at page 20 schedules a complete reconciliation',async()=>{
  const state=initialState();state.archive.completedAt=100;
  state.feeds.created_at={head:[999999],scan:{page:20,head:[1],seen:[]}};
  const client={async get(url){assert.equal(Number(new URL(url,base).searchParams.get('page')),20);return {html:listing(Array.from({length:60},(_,i)=>card(1141+i)),1300,20)};}};
  await scanFeed(client,state,'created_at',{now:10000,save(){}});assert.equal(state.archive.completedAt,0);assert(!state.feeds.created_at.scan);
});
test('incomplete season does not overwrite the prior record',async t=>{
  const root=tmp(t),state=initialState();observe(state,card(1),1);const old={sentinel:'preserved'};write(itemFile(root,1),old);
  const client={async get(){return {html:page(1,[{id:101,number:1,episodes_count:2}],1)};}};
  await assert.rejects(collect(client,state,root,1,{now:100,save(){}}),/Incomplete season/);assert.deepEqual(read(itemFile(root,1)),old);
});
test('HTTP error after two archive omissions without health controls fails closed',async t=>{
  const root=tmp(t),state=initialState();observe(state,card(1),1);state.known[1].missingScans=2;
  state.origins={site:base,images:'https://cdn.streamingunity.fun'};write(itemFile(root,1),{id:1,path:'/it/titles/1-title-1',info:{name:'Kept'},seasons:[],seasonIndex:[],active:true});write(path.join(root,'state.json'),state);
  const client={async discover(){return {baseUrl:base,cdn:state.origins.images,genres:[]};},async get(){throw Object.assign(new Error('HTTP 404'),{status:404});}};
  const result=await run({root,client,stage:'details'});assert.equal(result.state.known[1].active,true);assert.equal(read(itemFile(root,1)).info.name,'Kept');assert.equal(verify(root).active,1);
});
test('wrong season 200 is rejected and images are domain independent',()=>{
  const seasons=[{id:101,number:1,episodes_count:1}];assert.throws(()=>detail(page(1,seasons,1),1,{},2),/wrong season/);
  const origins={site:base};const d=detail(page(1,seasons,1),1,origins,1);assert.deepEqual(d.images[0].reference,{base:'images',path:'/images/a.webp'});assert.equal(d.season.episodes[0].plot,'Plot');
});
test('external image overrides are preserved like the Vega provider',()=>{
  const p=JSON.parse(page());p.props.title.images=[{original_url_field:'https://image.tmdb.org/t/p/original/a.jpg',filename:'fallback.webp'}];
  const d=detail(JSON.stringify(p),1,{});assert.deepEqual(d.images[0].reference,{url:'https://image.tmdb.org/t/p/original/a.jpg'});
});
test('season checkpoints resume without fetching already completed seasons',async t=>{
  const root=tmp(t),state=initialState();state.origins.site=base;observe(state,card(1),1);
  const seasons=[1,2,3].map(n=>({id:n+100,number:n,episodes_count:1}));const calls=[];
  const client={async get(url){calls.push(url);const n=Number(url.match(/season-(\d+)/)?.[1]||1);return {html:page(1,seasons,n)};}};
  await collect(client,state,root,1,{now:100,save(){},maxSeasons:1});assert(!read(itemFile(root,1)));
  await collect(client,state,root,1,{now:100,save(){},maxSeasons:1});assert.equal(read(itemFile(root,1)).seasons.length,3);assert.equal(calls.length,3);
});
test('fallback order, session isolation and WARP fail closed',async()=>{
  const urls=[];const transport=async req=>{urls.push(req.url);if(req.url.includes('pastebin'))return {status:200,headers:{},data:'https://streamingunity.test\nhttps://streamingcommunity.test'};
    if(req.url.startsWith('https://streamingcommunity.test'))return {status:200,headers:{},data:JSON.stringify({props:{titles:[],totalCount:0,cdn_url:'https://cdn.streamingcommunity.test'}})};
    return {status:404,headers:{},data:''};};
  const c=new Client({transport,guard(){},delay:0,wait:async()=>{}});await c.discover();assert.deepEqual(urls.slice(1),['https://streamingunity.test/it/archive',FALLBACK+'/it/archive','https://streamingcommunity.test/it/archive']);
  assert.equal(COMMUNITY_FALLBACK,'https://streamingcommunityz.day');
  const blocked=new Client({transport,guard(){throw new Error('WARP_REQUIRED');},delay:0});await assert.rejects(blocked.discover(),/WARP_REQUIRED/);
  const jar=new Client();jar.remember({headers:{'set-cookie':['a=secret; Path=/']}},new URL(base));assert(!jar.cookies.has('streamingcommunityz.day'));
});
test('workflow requires WARP, manual stages and no push trigger',()=>{
  const yaml=fs.readFileSync(path.join(__dirname,'../../..','.github/workflows/update-streamingunity.yml'),'utf8');
  assert.match(yaml,/workflow_dispatch:/);assert.match(yaml,/options: \[all, discover, details, publish\]/);
  assert.match(yaml,/WARP_REQUIRED: '1'/);assert(!/^\s+push:/m.test(yaml));
  assert.match(yaml,/sparse-checkout: \|\s+\.github\/workflows\s+providers\/streamingunity/);
});
test('pipeline exports verified data and does not repeat fresh details',async t=>{
  const root=tmp(t);let details=0;const client={baseUrl:base,async discover(){return {baseUrl:base,cdn:'https://cdn.streamingunity.fun',genres:[]};},async get(url){if(url.includes('/titles/')){details++;return {html:page()};}return {html:listing([card(1)],1)};}};
  const first=await run({root,client,maxRequests:10});assert(first.complete);assert.equal(verify(root).count,1);
  await run({root,client});assert.equal(details,1);
  const state=read(path.join(root,'state.json'));state.known[1].active=false;write(path.join(root,'state.json'),state);await run({root,stage:'publish'});assert.equal(verify(root).active,0);assert.equal(read(itemFile(root,1)).info.name,'Title 1');
});

test('activity counters including translated views do not schedule detail refresh',()=>{
  const state=initialState(),value={...card(1),views:10,favorites:3,members:4,translations:[
    {id:1,locale:'it',key:'views',value:'100'}, {id:2,locale:'it',key:'daily_views',value:'10'},
    {id:3,locale:'it',key:'plot',value:'Plot'}]};
  observe(state,value,1);const changed=structuredClone(value);
  changed.views++;changed.favorites++;changed.members++;changed.translations[0].value='101';changed.translations[1].value='11';
  observe(state,changed,2);assert.equal(state.known[1].refresh,false);
  assert.equal(state.known[1].activityCounters['/translations/it/views'],'101');
  assert.equal(state.known[1].activityCounters['/favorites'],4);
  assert.equal(value.translations[0].value,'100');assert.equal(state.known[1].fingerprintVersion,3);
});
test('real catalog metadata changes and reactivation still schedule refresh',()=>{
  for(const mutate of [c=>c.name='Other',c=>c.slug='other',c=>c.score=8,c=>c.last_air_date='2026-11-01',
    c=>c.seasons_count=2,c=>c.images=[{filename:'new.webp'}],c=>c.translations[0].value='New plot']){
    const state=initialState(),value={...card(1),translations:[{locale:'it',key:'plot',value:'Old plot'}]};
    observe(state,value,1);const next=structuredClone(value);mutate(next);observe(state,next,2);
    assert.equal(state.known[1].refresh,true);
  }
  const state=initialState();observe(state,card(1),1);state.known[1].active=false;observe(state,card(1),2);
  assert.equal(state.known[1].refresh,true);
});
test('legacy fingerprints migrate unchanged cards without scheduling a full refresh',()=>{
  const state=initialState(),value=card(1),{hash}=require('../scripts/store');
  state.known[1]={id:1,active:true,fingerprint:hash(value),refresh:false};
  observe(state,value,2);assert.equal(state.known[1].refresh,false);assert.equal(state.known[1].fingerprintVersion,3);
  const other=initialState();other.known[1]={id:1,active:true,fingerprint:hash(value),refresh:false};
  observe(other,{...value,name:'New title'},2);assert.equal(other.known[1].refresh,true);
  observe(other,{...value,name:'New title',views:10},3);assert.equal(other.known[1].refresh,true);
  other.known[1].refresh=false;observe(other,{...value,name:'New title',views:11},4);assert.equal(other.known[1].refresh,false);
});
test('counter-only observations leave periodic checks and error retries intact',()=>{
  const state=initialState();observe(state,{...card(1),views:1},1);
  state.records[1]={complete:true,checkedAt:1,nextCheckAt:900};state.errors['item:1']={retryAt:500};
  observe(state,{...card(1),views:2},2);
  assert.equal(state.records[1].nextCheckAt,900);assert.equal(state.errors['item:1'].retryAt,500);
  assert.equal(state.known[1].refresh,false);
});

test('season refresh reuses unchanged older seasons, checks latest, and expires independently',async t=>{
  const root=tmp(t),state=initialState(),start=1000000000000;
  let seasons=[{id:100,number:0,episodes_count:1},{id:101,number:1,episodes_count:1},{id:102,number:2,episodes_count:1}],calls=[];
  observe(state,card(1),start);
  const client={async get(url){calls.push(url);const match=url.match(/season-(\d+)$/);return {html:page(1,seasons,match?Number(match[1]):undefined)};}};
  await collect(client,state,root,1,{now:start,save(){}});assert.equal(calls.length,4);
  calls=[];await collect(client,state,root,1,{now:start+86400000,save(){}});
  assert.equal(calls.length,2);assert(calls[1].endsWith('season-2'));
  assert.equal(state.records[1].seasonCheckedAt[0],start);
  calls=[];seasons[0]={...seasons[0],name:'Corrected special season'};
  await collect(client,state,root,1,{now:start+2*86400000,save(){}});
  assert.equal(calls.length,3);assert(calls.some(p=>p.endsWith('season-0')));
  calls=[];await collect(client,state,root,1,{now:start+32*86400000,save(){}});assert.equal(calls.length,4);
  calls=[];state.fullSince=start+33*86400000;
  await collect(client,state,root,1,{now:state.fullSince,save(){}});assert.equal(calls.length,4);
  seasons=seasons.filter(s=>s.number!==0);calls=[];
  await collect(client,state,root,1,{now:start+34*86400000,save(){}});
  assert.deepEqual(read(itemFile(root,1)).seasons.map(s=>s.number),[1,2]);
});
test('new season is acquired while old seasons are reused and legacy timestamps force validation',async t=>{
  const root=tmp(t),state=initialState(),start=1000000000000;let seasons=[{id:101,number:1,episodes_count:1}],calls=[];
  observe(state,card(1),start);
  const client={async get(url){calls.push(url);const match=url.match(/season-(\d+)$/);return {html:page(1,seasons,match?Number(match[1]):undefined)};}};
  await collect(client,state,root,1,{now:start,save(){}});
  seasons.push({id:102,number:2,episodes_count:1});calls=[];
  await collect(client,state,root,1,{now:start+86400000,save(){}});
  assert.equal(calls.length,2);assert(calls[1].endsWith('season-2'));
  delete state.records[1].seasonCheckedAt;calls=[];
  await collect(client,state,root,1,{now:start+2*86400000,save(){}});assert.equal(calls.length,3);
});

test('older season episode-count changes and unknown counts are never treated as unchanged',async t=>{
  const root=tmp(t),state=initialState(),start=1000000000000;let seasons=[{id:101,number:1,episodes_count:1},{id:102,number:2,episodes_count:1}],calls=[];
  observe(state,card(1),start);
  const client={async get(url){calls.push(url);const m=url.match(/season-(\d+)$/),n=m?Number(m[1]):undefined;
    const data=JSON.parse(page(1,seasons,n));if(n!==undefined&&seasons.find(s=>s.number===n).episodes_count===2)
      data.props.loadedSeason.episodes.push({id:500,number:2,season_id:n+100,images:[]});
    return {html:JSON.stringify(data)};}};
  await collect(client,state,root,1,{now:start,save(){}});
  seasons[0].episodes_count=2;calls=[];await collect(client,state,root,1,{now:start+1,save(){}});
  assert.equal(calls.length,3);assert.equal(read(itemFile(root,1)).seasons[0].episodes.length,2);
  delete seasons[0].episodes_count;calls=[];await collect(client,state,root,1,{now:start+2,save(){}});
  assert.equal(calls.length,3);
});

test('localized direct counters are retained without refresh and v2 cards migrate safely',()=>{
 const {cardFingerprint,legacyCardFingerprint}=require('../scripts/card-fingerprint');
 const value={...card(1),views_it:10,daily_views_en:2,updated_at:'old'};
 const state=initialState();state.known[1]={id:1,active:true,fingerprint:legacyCardFingerprint(value),fingerprintVersion:2,refresh:false};
 observe(state,value,1);assert.equal(state.known[1].refresh,false);assert.equal(state.known[1].fingerprintVersion,3);
 observe(state,{...value,views_it:11,daily_views_en:3},2);assert.equal(state.known[1].refresh,false);assert.equal(state.known[1].activityCounters['/views_it'],11);
 assert.notEqual(cardFingerprint(value),cardFingerprint({...value,updated_at:'new'}));
 observe(state,{...value,name:'Changed'},3);assert.equal(state.known[1].refresh,true);
});
