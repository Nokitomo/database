'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {archive,detail}=require('../scripts/parse'),{Client}=require('../scripts/http');
const {run,scanArchive,collect,scanFeed}=require('../scripts/pipeline');
const {initialState,observe,read,write,itemFile,publish}=require('../scripts/store'),{verify}=require('../scripts/verify');
const base='https://altadefinizionex.vip';
const card=id=>({id,slug:'title-'+id,title:'Title '+id,kind:'series'});
const fixture=(id=1,seasons=[{number:0,episodes:[{number:0,title:'Special',plot:'Plot',still:'https://img.altadefinizionex.vip/t/p/w780/x.jpg'}]}])=>{
  const props={item:{...card(id),tmdbId:42,imdbId:'tt1234567',posterUrl:'https://img.altadefinizionex.vip/t/p/w500/x.jpg',posterPaths:['/x.jpg'],numberOfSeasons:9,numberOfEpisodes:99},seasons};
  const data='a:'+JSON.stringify(props)+'\n';return `<script>self.__next_f.push(${JSON.stringify([1,data.slice(0,60)])})</script><script>self.__next_f.push(${JSON.stringify([1,data.slice(60)])})</script>`;
};
function tmp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'alta-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const listing=(total,offset=0)=>JSON.stringify({ok:true,count:total,items:Array.from({length:Math.max(0,Math.min(30,total-offset))},(_,i)=>card(offset+i+1))});
test('parse chunks without eval; zero, fractions and actual counts survive',()=>{
  const r=detail(fixture(1,[{number:0,episodes:[{number:0},{number:3.5}]},{number:1,episodes:[]}]),1,{site:base});
  assert.deepEqual(r.seasons[0].episodes.map(x=>x.number),[0,3.5]);assert.equal(r.warnings.length,2);
  assert.equal(r.images[0].reference.base,'images');assert.equal(r.images[1].language,null);
  assert.throws(()=>detail(fixture(),2,{site:base}),/identity/);
  assert.throws(()=>detail(fixture(1,[{number:1,episodes:[{number:1},{number:1}]}]),1,{site:base}),/episode/);
  assert.throws(()=>detail('<html>Challenge</html>',1,{site:base}),/structured/);
  assert.throws(()=>archive('{"items":[]}'),/archive/);
});
test('domain changes preserve record image references and identity',()=>{
  assert.deepEqual(detail(fixture(),1,{site:base}),detail(fixture().replaceAll('altadefinizionex.vip','altadefinizionex.example'),1,{site:'https://altadefinizionex.example'}));
});
test('Flight text references decode UTF-8 byte lengths without running scripts',()=>{
  const text='Una città è qui: 東京',props={item:{...card(1),plot:'$ab'},seasons:[]};
  const flight='ab:T'+Buffer.byteLength(text).toString(16)+','+text+'\na:'+JSON.stringify(props)+'\n';
  const html='<script>throw new Error("must never run")</script><script>self.__next_f.push('+JSON.stringify([1,flight])+')</script>';
  assert.equal(detail(html,1,{site:base}).info.plot,text);
});
test('HTTP 429 honors Retry-After and cross-family redirects are rejected',async()=>{
  let n=0;const waits=[];const c=new Client({delay:0,guard(){},wait:async ms=>waits.push(ms),transport:async()=>++n===1?{status:429,headers:{'retry-after':'2'},data:''}:{status:200,headers:{},data:'ok'}});c.baseUrl=base;
  assert.equal((await c.get('/archivio')).html,'ok');assert(waits.includes(2000));
  const other=new Client({delay:0,guard(){},wait:async()=>{},transport:async()=>({status:302,headers:{location:'https://elsewhere.invalid/'},data:''})});other.baseUrl=base;await assert.rejects(other.get('/'),/origin/);
});
test('complete archive exceeds 20 pages and resumes exact cursor',async()=>{
  const state=initialState(),calls=[];let fail=true;
  const client={async get(url){let offset=Number(new URL(url,base).searchParams.get('offset'));calls.push(offset);if(offset===30&&fail)throw Error('network');return {html:listing(1301,offset)};}};
  await assert.rejects(scanArchive(client,state,{now:100,save(){},maxRequests:10}),/network/);assert.equal(state.archive.scan.offset,30);
  fail=false;while(!state.archive.completedAt)await scanArchive(client,state,{now:101,save(){},maxRequests:5});
  assert.equal(Object.keys(state.known).length,1301);assert(calls.includes(1290));
});
test('changed totals, repeats, truncated pages and empty previous catalog fail closed',async()=>{
  for(const mode of ['changed','repeat','truncated','empty']){
    const state=initialState();observe(state,card(999),1);let n=0;
    const client={async get(url){n++;const offset=Number(new URL(url,base).searchParams.get('offset'));let p=JSON.parse(listing(mode==='empty'?0:61,mode==='repeat'?0:offset));if(mode==='changed'&&n>1)p.count++;if(mode==='truncated')p.items.pop();return {html:JSON.stringify(p)};}};
    await assert.rejects(scanArchive(client,state,{now:100,save(){},maxRequests:10}));assert.equal(state.known[999].missingScans,0);assert(!state.archive.completedAt);
  }
});
test('updates refresh unchanged cards because episode metadata may have changed',async()=>{
  const state=initialState();observe(state,card(1),1);state.known[1].refresh=false;
  await scanFeed({get:async()=>({html:listing(1)})},state,'Data di aggiornamento',{now:100,save(){}});
  assert(state.known[1].refresh);
});
test('atomic detail replacement preserves last good record on malformed response',async t=>{
  const root=tmp(t),state=initialState();state.origins.site=base;observe(state,card(1),1);
  await collect({get:async()=>({html:fixture()})},state,root,1,{now:100,save(){}});
  const before=read(itemFile(root,1));await assert.rejects(collect({get:async()=>({html:'bad'})},state,root,1,{now:101,save(){}}));assert.deepEqual(read(itemFile(root,1)),before);
});
test('end to end source exports, retirement and reactivation keep metadata',async t=>{
  const root=tmp(t),client={discover:async()=>({baseUrl:base}),get:async u=>({html:u.startsWith('/api/')?listing(1):fixture()})};
  let r=await run({root,client,now:1000});assert(r.complete);assert.equal(verify(root).count,1);
  const state=r.state;state.known[1].active=false;publish(root,state,{complete:true,pendingCount:0});assert.equal(verify(root).active,0);assert(read(itemFile(root,1)).seasons.length);
  observe(state,card(1),2000);publish(root,state,{complete:true,pendingCount:0});assert.equal(verify(root).active,1);
  const bad=read(itemFile(root,1));bad.info.name='tampered';write(itemFile(root,1),bad);assert.throws(()=>verify(root),/record/);
});
test('HTTP domain discovery follows valid redirects; WARP fails closed',async()=>{
  const urls=[];const c=new Client({delay:0,wait:async()=>{},guard(){},transport:async req=>{
    urls.push(req.url);return {status:req.url==='https://altadefinizionex.forum/archivio'?301:200,headers:{location:base+'/archivio'},data:req.url.includes('pastebin')?'https://altadefinizionex.forum':req.url.includes('/api/')?listing(1):'<html>Archive</html>'};}});
  assert.equal((await c.discover()).baseUrl,base);assert(urls.some(x=>x.startsWith(base)));
  const blocked=new Client({guard(){throw Error('WARP_REQUIRED');},transport:()=>{throw Error('must not request');}});await assert.rejects(blocked.discover(),/WARP_REQUIRED/);
});
test('retirement requires two full omissions plus 404; reactivation keeps identity',async t=>{
  const root=tmp(t);let present=true,network=false;
  const client={discover:async()=>({baseUrl:base}),async get(u){
    if(u.startsWith('/api/'))return {html:JSON.stringify({ok:true,count:present?2:1,items:present?[card(1),card(2)]:[card(2)]})};
    const id=Number(u.match(/\/(\d+)-/)[1]);if(id===1&&!present){const e=Error(network?'network':'HTTP 404');if(!network)e.status=404;throw e;}
    return {html:fixture(id)};
  }};
  await run({root,client,now:100});present=false;
  let r=await run({root,client,now:8*86400000});assert(r.state.known[1].active);assert.equal(r.state.known[1].missingScans,1);
  network=true;r=await run({root,client,now:16*86400000});assert(r.state.known[1].active);
  network=false;r=await run({root,client,now:16*86400000+3600001});assert.equal(r.state.known[1].active,false);assert(read(itemFile(root,1)).seasons.length);
  present=true;r=await run({root,client,now:24*86400000});assert(r.state.known[1].active);assert.equal(verify(root).active,2);
});
module.exports={fixture};

test('selective collection retains source metadata and avoids repeated detail requests',async t=>{
 const root=tmp(t),s=initialState();s.origins.site=base;const sample=detail(fixture(),1,s.origins);observe(s,card(1),100);
 let calls=0;const client={coverage:require('../../../shared/catalog/tests/fixtures').coverageFor(sample,'altadefinizione',root),get:async()=>{calls++;return {html:fixture()}}};
 await collect(client,s,root,1,{now:100,save(){}});assert.equal(read(itemFile(root,1)).collection.mode,'linked');
 await collect(client,s,root,1,{now:101,save(){}});assert.equal(calls,1);
 client.coverage=null;require('../../../shared/catalog/collection').configure(client,'altadefinizione',root,s,102);await collect(client,s,root,1,{now:102,save(){}});assert.equal(calls,2);assert.equal(read(itemFile(root,1)).collection.mode,'full');
});
