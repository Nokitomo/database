'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {archive,indexLinks,detail,connectedPage}=require('../scripts/parse');
const {Client,PASTEBIN}=require('../scripts/http');
const {siteOrigin,reference}=require('../scripts/urls');
const {run,scanArchive,collect,queue,INDEXES}=require('../scripts/pipeline');
const {read,write,initialState,observe,publish,itemFile}=require('../scripts/store');
const {verify}=require('../scripts/verify');
const base='https://eurostreamings.reisen';
function fixture({id=1,blocks,connected=false}={}){return `<html><body class="single postid-${id}"><div class="post-entry"><h1 class="entry-title">Yaga</h1><div class="entry-content"><img src="https://imgcdn.cc/poster.jpg"><p>Serie TV del 2026. <span style="display:none">Trama completa <a href="https://www.imdb.com/title/tt39980704/">Continua a leggere</a></span></p>${connected?'<span class="nano_cp_button"></span>':blocks||block('STAGIONE 1 ITA','1×01 Primo – <a href="https://host.invalid/1">Host</a><br>1×02 Secondo – <a href="https://host.invalid/2">Host</a>')}</div></div>${connected?'<script>var nano_ajax_object = {"go_to":"/yaga-episodi/"};</script>':''}</body></html>`;}
function block(title,rows){return `<div class="su-spoiler"><div class="su-spoiler-title">${title}</div><div class="su-spoiler-content">${rows}</div></div>`;}
function index(page=1,pages=1,ids=[1]){return `<body class="category-serie-tv-archive">${ids.map(id=>`<li id="post-${id}"><h2><a href="/show-${id}/">Show ${id}</a></h2><img src="/poster-${id}.jpg"></li>`).join('')}<span class="page-numbers current">${page}</span><a class="page-numbers">${pages}</a></body>`;}
const list=(paths=['/show-1/'])=>`<body class="page"><div class="entry">${paths.map(p=>`<a href="${p}">Show</a>`).join('')}</div></body>`;
function tmp(t){const r=fs.mkdtempSync(path.join(os.tmpdir(),'eurostreaming-test-'));t.after(()=>fs.rmSync(r,{recursive:true,force:true}));return r;}
function mock(){return {baseUrl:base,discover:async()=>({baseUrl:base}),get:async p=>({url:base+p,html:p.startsWith('/category/')?index():INDEXES.includes(p)?list():p==='/nuovi-ep-aggiornamento/'?'<body class="page"><div id="main"><a href="/show-1/">1x02 Secondo</a></div></body>':fixture()})};}
test('archive validates pagination and rejects truncation, duplicates and challenge HTML',()=>{
 assert.equal(archive(index(),base).items[0].id,1);
 assert.throws(()=>archive(index(1,2),base),/Incomplete/);
 assert.throws(()=>archive(index(1,1,[1,1]),base),/repeated/);
 assert.throws(()=>archive(index(),base,21),/repeated/);
 assert.throws(()=>archive('<title>Just a moment</title>',base),/Invalid/);
});
test('indexes exclude external providers, navigation and anchor links',()=>{
 assert.deepEqual(indexLinks(list(['/show-1/','https://filmez.club/a','https://animetop.net/a','#a','/elenco-serie-tv/']),base,'index'),['/show-1/']);
 assert.throws(()=>indexLinks('<body>bad</body>',base,'index'));
});
test('detail preserves hidden synopsis, IMDb, artwork reference and stable identity',()=>{
 const origins={site:base},r=detail(fixture(),1,origins,'/yaga/');
 assert.equal(r.info.year,2026);assert(r.info.plot.includes('Trama completa'));assert.equal(r.sourceIds.imdb_id,'tt39980704');assert.equal(r.images[0].reference.base,'images0');assert.equal(origins.images0,'https://imgcdn.cc');assert.equal(r.episodeMappingUncertain,true);
 assert.throws(()=>detail(fixture(),2,origins,'/wrong/'),/identity/);
});
test('ITA/SUB ITA versions, announced seasons, zero, fractional and double episodes remain distinct',()=>{
 const r=detail(fixture({blocks:block('STAGIONE 0 ITA','0×01 Speciale – <a href="https://host/1">Host</a>')+block('STAGIONE 1 ITA','1×00 Zero<br>1×3.5 Speciale<br>1×01-02 Doppio<br>1×03 Terzo')+block('STAGIONE 1 (SUB ITA)','1×03 Third')+block('STAGIONE 2 ITA','Coming soon…')}),1,{site:base},'/x/');
 assert.deepEqual(r.seasons[1].episodes.map(e=>e.number),[0,3.5,'01-02',3]);assert.equal(r.seasons[1].episodes[3].variants.length,2);assert.equal(r.seasons[2].episodes.length,0);assert.equal(r.episodeBlocks[3].announced,true);
});
test('conflicting repeated season blocks and alternative numbering are retained',()=>{
 const r=detail(fixture({blocks:block('STAGIONE 16 ITA (gennaio)','16×01 Primo')+block('STAGIONE 16 ITA (settembre)','16×01 Altro')}),1,{site:base},'/x/');
 assert(r.warnings.includes('ambiguous-episode-numbering'));assert.equal(r.episodeBlocks.length,2);assert.equal(r.seasons[0].episodes[0].variants.length,2);
});
test('linked episode page is data, never evaluated; missing and unrecognized rows fail safely',()=>{
 const html=fixture({connected:true});assert.equal(connectedPage(html,base),'/yaga-episodi/');
 assert.throws(()=>detail(html,1,{site:base},'/x/'),/not loaded/);
 assert.equal(detail(html,1,{site:base},'/x/',fixture()).seasons.length,1);
 assert.throws(()=>detail(fixture({blocks:block('STAGIONE 1 ITA','unexpected <a href="https://host/1">Host</a>')}),1,{site:base},'/x/'),/Unparsed/);
});
test('dynamic origins preserve paths and reject unrelated site redirects',()=>{
 const origins={site:base};assert.deepEqual(reference('/x.jpg',origins),{base:'site',path:'/x.jpg'});assert.equal(reference('https://imgcdn.cc/a',origins).base,reference('https://imgcdn.cc/b',origins).base);
 assert.throws(()=>siteOrigin('https://eurostreaming.design'));assert.throws(()=>siteOrigin('https://eurostreamings.reisen.evil.test'));
});
test('discovery retries fallback and validates actual archive; WARP fails closed',async()=>{
 const seen=[];const c=new Client({delay:0,wait:async()=>{},guard:()=>{},transport:async o=>{seen.push(o.url);return {status:200,headers:{},data:o.url===PASTEBIN?'https://eurostreamings.invalid':o.url.includes('.invalid')?'bad':index()};}});
 assert.equal((await c.discover()).baseUrl,base);assert(seen.some(s=>s.includes('.invalid')));
 const blocked=new Client({guard:()=>{throw Error('WARP_REQUIRED');},transport:()=>assert.fail('network')});await assert.rejects(blocked.discover(),/WARP_REQUIRED/);
});
test('HTTP retries 429, keeps cookies host scoped and blocks third-party redirects',async()=>{
 let count=0;const waits=[];const c=new Client({delay:0,guard:()=>{},wait:async n=>waits.push(n),transport:async o=>{count++;if(count===1)return {status:429,headers:{'retry-after':'2'},data:''};return {status:200,headers:{'set-cookie':['x=1; Path=/']},data:'ok'};}});c.baseUrl=base;await c.get('/');assert(waits.includes(2000));
 c.transport=async o=>{assert.equal(o.headers.Cookie,'x=1');return {status:302,headers:{location:'https://evil.invalid/'},data:''};};await assert.rejects(c.get('/'),/origin/);
});
test('archive resumes at saved page and only reconciles after supplemental indexes and boundary checks',async()=>{
 const s=initialState(),ids=Array.from({length:18},(_,i)=>i+1);observe(s,{id:99,path:'/absent/'},1);
 const c=mock();c.get=async p=>({html:p.includes('/page/2/')?index(2,2,[19]):INDEXES.includes(p)?list():index(1,2,ids)});
 await scanArchive(c,s,{now:100,save:()=>{},maxRequests:1});assert.equal(s.archive.scan.page,2);assert.equal(s.known[99].missingScans,0);
 await scanArchive(c,s,{now:100,save:()=>{},maxRequests:10});assert.equal(s.archive.total,19);assert.equal(s.known[99].missingScans,1);
});
test('complete publication, restart, manual publish and hash verification',async t=>{
 const root=tmp(t);let r=await run({root,client:mock(),now:100,maxRequests:10});assert(r.complete);assert.equal(verify(root).count,1);
 r=await run({root,client:mock(),now:101});assert(r.complete);assert.equal(r.hasImmediateWork,false);
 const publishOnly=await run({root,stage:'publish',client:{discover:()=>assert.fail()},now:102});assert(publishOnly.complete);
 const item=read(itemFile(root,1));item.info.name='tampered';write(itemFile(root,1),item);assert.throws(()=>verify(root));
});
test('detail failure retains old data and is retried after backoff',async t=>{
 const root=tmp(t);await run({root,client:mock(),now:100,maxRequests:10});const old=read(itemFile(root,1));const c=mock();c.get=async()=>({html:'blocked'});
 const r=await run({root,client:c,stage:'details',now:86400101});assert(!r.complete);assert.deepEqual(read(itemFile(root,1)),old);assert(r.state.errors['item:1']);
});
test('two full omissions plus main page 404 retire without deleting metadata; a linked-page 404 does not',async t=>{
 const root=tmp(t);await run({root,client:mock(),now:100,maxRequests:10});let s=read(path.join(root,'state.json'));s.known[1].missingScans=2;write(path.join(root,'state.json'),s);
 const c=mock();c.get=async p=>{if(p==='/show-1/')return {url:base+p,html:fixture({connected:true})};throw Object.assign(Error('HTTP 404'),{status:404});};
 await run({root,client:c,stage:'details',now:101});assert(read(path.join(root,'state.json')).known[1].active);
 c.get=async()=>{throw Object.assign(Error('HTTP 404'),{status:404});};await run({root,client:c,stage:'details',now:3600102});assert.equal(read(itemFile(root,1)).active,false);assert.equal(verify(root).active,0);
 s=read(path.join(root,'state.json'));queue(s,'/show-1/',3600103,true);write(path.join(root,'state.json'),s);await run({root,client:mock(),stage:'details',now:3600103});assert(read(itemFile(root,1)).active);
});
test('workflow is independent, scheduled/manual and never starts on push',()=>{
 const y=fs.readFileSync(path.resolve(__dirname,'../../../.github/workflows/update-eurostreaming.yml'),'utf8');assert(y.includes('workflow_dispatch:'));assert(y.includes("WARP_REQUIRED: '1'"));assert(!/^\s+push:/m.test(y));assert(y.includes('eurostreaming-database-main'));
});
test('archive continues past page 20 and bounds checks failures never establish absence',async()=>{
 const s=initialState();observe(s,{id:9999,path:'/old/'},1);let requested=[];
 const c=mock();c.get=async p=>{if(INDEXES.includes(p))return {html:list()};const page=Number(p.match(/page\/(\d+)/)?.[1]||1);requested.push(page);return {html:index(page,21,Array.from({length:page===21?2:18},(_,i)=>(page-1)*18+i+1))};};
 await scanArchive(c,s,{now:100,save:()=>{},maxRequests:20});assert.equal(s.archive.scan.page,21);assert.equal(s.known[9999].missingScans,0);
 await scanArchive(c,s,{now:100,save:()=>{},maxRequests:10});assert(requested.includes(21));assert.equal(s.archive.total,362);assert.equal(s.known[9999].missingScans,1);
 const bad=initialState();observe(bad,{id:9999,path:'/old/'},1);const failing=mock();failing.get=async p=>{if(INDEXES.includes(p))throw Error('network');return {html:index()};};
 await assert.rejects(scanArchive(failing,bad,{now:100,save:()=>{},maxRequests:10}),/network/);assert.equal(bad.known[9999].missingScans,0);assert(!bad.archive.completedAt);
});
test('full refresh survives batches and archive movement invalidates reconciliation',async t=>{
 const root=tmp(t),c=mock();await run({root,client:c,now:100,maxRequests:10});
 let r=await run({root,client:mock(),mode:'full',now:200,maxRequests:1,maxItems:0});assert.equal(r.state.fullSince,200);assert(r.state.archive.scan);
 r=await run({root,client:mock(),now:201,maxRequests:10});assert(r.complete);assert.equal(r.state.fullSince,undefined);
 const state=initialState(),moving=mock();let n=0;moving.get=async p=>({html:INDEXES.includes(p)?list():index(1,1,[++n===1?1:2])});
 await assert.rejects(scanArchive(moving,state,{now:100,save:()=>{},maxRequests:10}),/changed/);assert(!state.archive.completedAt);
});
test('alias discovery is deduplicated and old provider image domains resolve through current site',()=>{
 const s=initialState();observe(s,{id:1,path:'/new/'},1);s.known[1].aliases=['/old/'];queue(s,'/old/',2,true);assert.equal(Object.keys(s.paths).length,0);assert(s.known[1].refresh);
 assert.deepEqual(reference('https://eurostreamings.old/wp-content/a.jpg',{site:base}),{base:'site',path:'/wp-content/a.jpg'});
});
module.exports={fixture,block,index,list};
