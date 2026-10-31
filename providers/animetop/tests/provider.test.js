'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {htmlArchive,apiArchive,detail}=require('../scripts/parse'),{Client,PASTEBIN}=require('../scripts/http');
const {siteOrigin,reference}=require('../scripts/urls'),{run,scanArchive,scanFeed,collect}=require('../scripts/pipeline');
const {initialState,observe,read,write,itemFile}=require('../scripts/store'),{verify}=require('../scripts/verify');
const base='https://animetop.net';
function listing(kind='tv_show',total=2,page=1){const size=kind==='movie'?24:30,cl=kind==='movie'?'movies':'tv-shows';return `<body class="post-type-archive-${kind}"><div class="masvideos-result-count">Showing ${(page-1)*size+1}–${Math.min(page*size,total)} of ${total} results</div><div id="primary"><div class="${cl}__inner">${Array.from({length:Math.min(size,total-(page-1)*size)},(_,i)=>{const id=(kind==='movie'?10000:0)+(page-1)*size+i+1;return `<div class="type-${kind} post-${id}"><a class="${kind==='movie'?'movie':'tv-show'}__link" href="/${id}/"><h3>Title ${id}</h3></a></div>`;}).join('')}</div></div><aside><div class="type-${kind} post-90000"><h3>Sidebar noise</h3></div></aside></body>`;}
function api(kind='tv_show',total=2,page=1,order='id',changed=false){const values=Array.from({length:total},(_,i)=>i+1+(kind==='movie'?10000:0));if(order==='modified')values.reverse();return {headers:{'x-wp-total':String(total),'x-wp-totalpages':String(Math.ceil(total/100))},html:JSON.stringify(values.slice((page-1)*100,page*100).map(id=>({id,link:base+'/'+id+'/',type:kind,title:{rendered:'Title '+id},modified_gmt:changed?'2026-10-30T12:00:00':'2026-10-20T00:00:00',date_gmt:'2026-10-01T00:00:00'})))};}
function fixture(id=1,kind='tv_show',rows='<tr><td colspan="4">Stagione 1</td></tr><tr><td>Show 01x01 Primo</td><td><a href="https://host.invalid/1">MaxStream</a></td></tr>'){
 const cl=kind==='movie'?'movie':'tv-show';return `<body class="single-${kind} postid-${id}"><div class="${cl}"><h1 class="entry-title">Title ${id}</h1><img class="${cl}__poster--image" src="/a.jpg" srcset="${base}/a.jpg 1000w, ${base}/a-300.jpg 300w"><div class="${cl}__description"><h4>Trama</h4><p>Sinossi completa</p></div><span class="tv-show__meta--release-year">2024-01-01 - 2024-01-01</span><span class="tv-show__meta--genre"><a>Animazione</a></span>${kind==='movie'?'<div class="movie_meta">Anno 2024 | Nazione Italia | Durata 90 | Genere Animazione</div><div class="summary"><a href="https://host.invalid/m">MaxStream</a></div>':`<table>${rows}</table>`}<section class="tv-show-related"><div class="type-tv_show"><img src="/unrelated.jpg"><a href="https://anilist.co/anime/999">Wrong ID</a></div></section></div></body>`;
}
function mock(){return {baseUrl:base,discover:async()=>({baseUrl:base}),get:async p=>{if(p.startsWith('/wp-json/')){const u=new URL(p,base),kind=u.pathname.split('/').at(-1);return api(kind,kind==='movie'?1:2,Number(u.searchParams.get('page')),u.searchParams.get('orderby'));}if(p==='/serie-tv/')return {html:listing()};if(p==='/movies/')return {html:listing('movie',1)};const id=Number(p.split('/')[1]);return {html:fixture(id,id>10000?'movie':'tv_show')};}};}
function tmp(t){const r=fs.mkdtempSync(path.join(os.tmpdir(),'animetop-test-'));t.after(()=>fs.rmSync(r,{recursive:true,force:true}));return r;}
test('HTML archives exclude sidebar cards and validate counts/page identity',()=>{
 assert.equal(htmlArchive(listing(),base,'tv_show',1).items.length,2);assert.throws(()=>htmlArchive(listing(),base,'tv_show',2),/Incomplete/);assert.throws(()=>htmlArchive('<title>blocked</title>',base,'tv_show',1));
});
test('API archive enforces header coverage, identity, media type and duplicates',()=>{
 assert.equal(apiArchive(api(),base,'tv_show',1).total,2);const bad=api();bad.headers['x-wp-total']='3';assert.throws(()=>apiArchive(bad,base,'tv_show',1),/coverage/);
 const wrong=api();wrong.html=JSON.stringify([{id:1,type:'movie'}]);assert.throws(()=>apiArchive(wrong,base,'tv_show',1));
 const duplicate=api();const rows=JSON.parse(duplicate.html);duplicate.html=JSON.stringify([rows[0],rows[0]]);assert.throws(()=>apiArchive(duplicate,base,'tv_show',1),/Repeated/);
});
test('detail keeps source metadata and all poster sizes without related images or IDs',()=>{
 const r=detail(fixture(),1,{site:base},'/1/','tv_show');assert.equal(r.images.length,2);assert(!r.sourceIds.anilistId);assert.equal(r.info.synopsis,'Sinossi completa');assert.equal(r.info.year,2024);assert.equal(r.episodes[0].title,'Primo');assert.equal(r.episodes[0].metadataMappingStatus,'unresolved');assert.throws(()=>detail(fixture(),2,{site:base},'/1/','tv_show'),/identity/);
});
test('season zero, fractional and double episodes retain original labels and conflicting headings',()=>{
 const rows='<tr><td>Stagione 3</td></tr>'+['00x00 Zero','00x3.5 Extra','01x01-02 Doppio','02x01 Primo'].map(t=>`<tr><td>Show ${t}</td><td><a href="https://host/1">Host</a></td></tr>`).join('');
 const r=detail(fixture(1,'tv_show',rows),1,{site:base},'/1/','tv_show');assert.deepEqual(r.episodes.map(e=>e.number),[0,3.5,'01-02',1]);assert.deepEqual(r.seasons.map(s=>s.number),[0,1,2]);assert(r.warnings.includes('season-heading-conflict'));assert.equal(r.episodes[3].heading,'Stagione 3');
});
test('unparsed rows are reported, duplicate coordinates retain alternatives, empty layout is not success',()=>{
 const row='<tr><td>Special episode</td><td><a href="https://host/1">Host</a></td></tr>';
 assert.equal(detail(fixture(1,'tv_show',row),1,{site:base},'/1/','tv_show').metadataComplete,false);
 const episode='<tr><td>Show 01x01 First</td><td><a href="https://host/1">Host</a></td></tr>';
 const r=detail(fixture(1,'tv_show',episode+episode),1,{site:base},'/1/','tv_show');assert.equal(r.episodes.length,1);assert.equal(r.episodes[0].variants.length,1);
 assert.throws(()=>detail(fixture().replace(/<table>[\s\S]*?<\/table>/,''),1,{site:base},'/1/','tv_show'),/layout/);
});
test('movies preserve metadata and playback references without inventing episodes',()=>{
 const r=detail(fixture(10001,'movie'),10001,{site:base},'/10001/','movie');assert.equal(r.info.runtime,90);assert.equal(r.info.country,'Italia');assert.equal(r.playback.length,1);assert.equal(r.episodes.length,0);assert.equal(r.playback[0].reference.url,'https://host.invalid/m');
});
test('discovery follows Eurostreaming, then last known and fallback; unrelated redirects rejected',async()=>{
 let broken=false;const seen=[];const c=new Client({delay:0,wait:async()=>{},guard:()=>{},transport:async o=>{seen.push(o.url);if(o.url===PASTEBIN)return {status:200,headers:{},data:'https://eurostreamings.reisen'};if(o.url.includes('eurostreamings'))return {status:200,headers:{},data:broken?'bad':'<div class="entry"><a href="https://animetop.test">AnimeTop</a><a href="https://evil.invalid">Other</a></div>'};return {status:200,headers:{},data:o.url.endsWith('/movies/')?listing('movie',1):listing()};}});
 assert.equal((await c.discover()).baseUrl,'https://animetop.test');broken=true;assert.equal((await c.discover('https://animetop.previous')).source,'last-known');
 assert.equal((await c.discover()).baseUrl,base);assert(!seen.some(u=>u.includes('evil')));assert.throws(()=>siteOrigin('https://animetop.net.evil.invalid'));
});
test('WARP is checked before requests and cookies are host-scoped',async()=>{
 const blocked=new Client({guard:()=>{throw Error('WARP_REQUIRED');},transport:()=>assert.fail()});await assert.rejects(blocked.discover(),/WARP_REQUIRED/);
 let n=0;const c=new Client({delay:0,wait:async()=>{},guard:()=>{},transport:async o=>{if(n++)assert(!o.headers.Cookie);return {status:200,headers:{'set-cookie':['x=secret; Path=/']},data:'ok'};}});await c.get(base);await c.get('https://eurostreamings.reisen');
});
test('site/image references tolerate domain changes without hardcoded item URLs',()=>{
 const origins={site:base};assert.deepEqual(reference('https://animetop.old/a.jpg',origins),{base:'site',path:'/a.jpg'});assert.equal(reference('https://cdn.invalid/b.jpg',origins).base,'images0');
});
test('full discovery covers both catalogs, resumes batches and cross-checks HTML totals',async()=>{
 const s=initialState();await scanArchive(mock(),s,{now:100,save(){},maxRequests:1});assert(s.archive.scan);assert.equal(Object.keys(s.known).length,2);
 await scanArchive(mock(),s,{now:100,save(){},maxRequests:10});assert.deepEqual(s.archive.counts,{tv_show:2,movie:1});assert.equal(s.archive.total,3);
 const bad=mock(),original=bad.get;bad.get=async p=>p==='/movies/'?{html:listing('movie',2)}:original(p);const broken=initialState();await assert.rejects(scanArchive(bad,broken,{now:100,save(){},maxRequests:10}),/coverage/);assert(!broken.archive.completedAt);
});
test('API unavailable falls back to full HTML archive, not just the first page',async()=>{
 const s=initialState(),c=mock();c.get=async p=>{if(p.startsWith('/wp-json/'))throw Error('unavailable');const kind=p.startsWith('/movies/')?'movie':'tv_show',n=Number(p.match(/page\/(\d+)/)?.[1]||1);return {html:listing(kind,kind==='movie'?25:31,n)};};await scanArchive(c,s,{now:100,save(){},maxRequests:20});assert.equal(s.archive.total,56);
});
test('modified feed discovers changed records and errors do not retire membership',async()=>{
 const s=initialState(),c=mock();await scanFeed(c,s,'tv_show',{now:100,save(){}});s.known[1].refresh=false;
 c.get=async()=>api('tv_show',2,1,'modified',true);await scanFeed(c,s,'tv_show',{now:7200101,save(){}});assert(s.known[1].refresh);assert(s.known[1].active);
});
test('pipeline exports valid records, retries errors atomically, and publish needs no network',async t=>{
 const root=tmp(t);const first=await run({root,client:mock(),now:100,maxRequests:10});assert(first.complete);assert.equal(verify(root).count,3);
 const old=read(itemFile(root,1)),c=mock();c.get=async()=>({html:'bad'});const r=await run({root,client:c,stage:'details',now:86400101});assert(!r.complete);assert.deepEqual(read(itemFile(root,1)),old);
 await run({root,client:{discover:()=>assert.fail()},stage:'publish',now:86400102});assert.equal(verify(root).count,3);
});
test('retirement needs two completed omissions and 404, preserving data for reactivation',async t=>{
 const root=tmp(t);await run({root,client:mock(),now:100,maxRequests:10});const s=read(path.join(root,'state.json'));s.known[1].missingScans=2;write(path.join(root,'state.json'),s);
 const c=mock(),get=c.get;c.get=async p=>{if(p==='/1/')throw Object.assign(Error('HTTP 404'),{status:404});return get(p);};await run({root,client:c,stage:'details',now:101});assert.equal(read(itemFile(root,1)).active,false);assert.equal(verify(root).active,2);
 const next=read(path.join(root,'state.json'));observe(next,{id:1,path:'/1/',name:'Title 1',kind:'tv_show'},102);write(path.join(root,'state.json'),next);await run({root,client:mock(),stage:'details',now:102});assert(read(itemFile(root,1)).active);
});
test('workflow uses a dedicated branch/concurrency, WARP, schedule and manual stages without push trigger',()=>{
 const y=fs.readFileSync(path.resolve(__dirname,'../../../.github/workflows/update-animetop.yml'),'utf8');assert(y.includes('workflow_dispatch:'));assert(y.includes("WARP_REQUIRED: '1'"));assert(y.includes('animetop-database-main'));assert(!/^\s+push:/m.test(y));
});
test('unparsed new title retains partial source metadata, while valid prior metadata is not overwritten',async t=>{
 const root=tmp(t),s=initialState();s.origins={site:base};observe(s,{id:1,path:'/1/',kind:'tv_show'},1);
 const c=mock();c.get=async()=>({html:fixture(1,'tv_show','<tr><td>Unclear special</td><td><a href="https://host/1">Host</a></td></tr>')});
 await assert.rejects(collect(c,s,root,1,{now:100,save(){}}),/Unparsed/);assert.equal(read(itemFile(root,1)).info.title,'Title 1');assert.equal(s.records[1].complete,false);
 const good=detail(fixture(),1,s.origins,'/1/','tv_show');write(itemFile(root,1),good);await assert.rejects(collect(c,s,root,1,{now:101,save(){}}),/Unparsed/);assert.deepEqual(read(itemFile(root,1)),good);
});
test('zero-padded duplicate coordinates coalesce while preserving the original variants',()=>{
 const rows=['01x001 First','01x01 First'].map(t=>`<tr><td>Show ${t}</td><td><a href="https://host/1">Host</a></td></tr>`).join('');
 const r=detail(fixture(1,'tv_show',rows),1,{site:base},'/1/','tv_show');assert.equal(r.episodes.length,1);assert.equal(r.episodes[0].variants.length,1);
});
test('HTML fallback resumes beyond page 20 without imposing a catalog cap',async()=>{
 const s=initialState(),seen=[],c=mock();c.get=async p=>{if(p.startsWith('/wp-json/'))throw Error('API disabled');const kind=p.startsWith('/movies/')?'movie':'tv_show',n=Number(p.match(/page\/(\d+)/)?.[1]||1);seen.push([kind,n]);return {html:listing(kind,kind==='movie'?1:601,n)};};
 await scanArchive(c,s,{now:100,save(){},maxRequests:20});assert(s.archive.scan);assert(!s.archive.completedAt);
 await scanArchive(c,s,{now:101,save(){},maxRequests:20});assert.equal(s.archive.total,602);assert(seen.some(([k,n])=>k==='tv_show'&&n===21));
});
test('manual full refresh persists across batches and completes through update continuation',async t=>{
 const root=tmp(t);await run({root,client:mock(),now:100,maxRequests:10});
 let r=await run({root,client:mock(),now:200,mode:'full',maxRequests:1,maxItems:0});assert.equal(r.state.fullSince,200);assert(r.hasImmediateWork);
 r=await run({root,client:mock(),now:201,maxRequests:10});assert(r.complete);assert.equal(r.state.fullSince,undefined);assert.equal(verify(root).count,3);
});

test('selective collection reuses verified records but archive changes force a page check',async t=>{
 const root=tmp(t),s=initialState(),client=mock();s.origins.site=base;observe(s,{id:1,path:'/1/',kind:'tv_show'},100);
 const sample=detail(fixture(),1,s.origins,'/1/','tv_show');client.coverage=require('../../../shared/catalog/tests/fixtures').coverageFor(sample,'animetop',root);
 let calls=0,get=client.get;client.get=async p=>{calls++;return get(p)};
 await collect(client,s,root,1,{now:100,save(){}});assert.equal(read(itemFile(root,1)).collection.mode,'linked');
 await collect(client,s,root,1,{now:101,save(){}});assert.equal(calls,1);
 s.known[1].refresh=true;await collect(client,s,root,1,{now:102,save(){}});assert.equal(calls,2);
});
