'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {checkRetirement}=require('../scripts/retirement');
const {initialState,observe,write,itemFile}=require('../scripts/store');
const HOUR=3600000;
const card=id=>({id,slug:'title-'+id,name:'Title '+id,type:'movie'});
const page=id=>JSON.stringify({props:{cdn_url:'https://cdn.streamingunity.fun',title:{...card(id),seasons:[],images:[]}}});
const listing=rows=>JSON.stringify({data:rows,current_page:1,per_page:60,total:rows.length,last_page:1});
function fixture(t,id=1){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'retirement-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=initialState();state.origins={site:'https://streamingunity.fun',images:'https://cdn.streamingunity.fun'};state.archive={completedAt:10};
  for(const n of [id,2,3])observe(state,card(n),1);
  state.known[id].missingScans=1;write(itemFile(root,id),{info:{name:'Title '+id,type:'movie'},seasons:[]});
  let status=404,search=[],unhealthy=false;
  const client={async get(url){if(url.startsWith('/it/archive?'))return {html:listing(search)};if(url===state.known[id].path){if(status===200)return {html:page(id)};throw Object.assign(Error('HTTP '+status),{status});}if(unhealthy)throw Error('network');return {html:page(Number(url.match(/titles\/(\d+)/)[1]))};}};
  const check=now=>checkRetirement(client,state,root,id,{now,save(){},health:{ok:false}});
  return {state,root,check,setStatus:v=>status=v,setSearch:v=>search=v,setUnhealthy:v=>unhealthy=v};
}
test('one omission plus two spaced title 404s retires and preserves metadata; reappearance reactivates',async t=>{
  const f=fixture(t);await assert.rejects(f.check(100),/404/);await assert.rejects(f.check(5*HOUR),/404/);
  write(path.join(f.root,'drafts','1.json'),{record:{path:f.state.known[1].path},finished:false});
  assert.equal(await f.check(6*HOUR+100),true);assert.equal(f.state.known[1].active,false);assert(fs.existsSync(itemFile(f.root,1)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'drafts','1.json'),'utf8')),null);
  observe(f.state,card(1),7*HOUR);assert.equal(f.state.known[1].active,true);assert.equal(f.state.known[1].notFound,undefined);assert(f.state.known[1].refresh);
});
test('reviewed LEGO removal still checks current 404, search and healthy controls',async t=>{
  const f=fixture(t,66477);f.state.known[66477].path=require('../retirements.json').titles['66477'].path;
  assert.equal(await f.check(Date.parse('2026-11-11T12:00:00Z')),true);assert.equal(f.state.known[66477].retirement.reason,'reviewed-removal');
});
test('stale slug, unhealthy controls and mass omissions prevent retirement',async t=>{
  const f=fixture(t);await assert.rejects(f.check(100));f.setSearch([{...card(1),slug:'new-slug'}]);
  assert.equal(await f.check(7*HOUR),false);assert(f.state.known[1].path.endsWith('new-slug'));assert.equal(f.state.known[1].missingScans,0);
  const g=fixture(t);await assert.rejects(g.check(100));g.setUnhealthy(true);await assert.rejects(g.check(7*HOUR),/network/);assert(g.state.known[1].active);
  g.setUnhealthy(false);for(let i=4;i<10;i++){observe(g.state,card(i),1);g.state.known[i].missingScans=1;}await assert.rejects(g.check(8*HOUR),/404/);assert(g.state.known[1].active);
});
test('403,429,5xx and successful recovery reset 404 evidence',async t=>{
  for(const status of [403,429,500]){const f=fixture(t);await assert.rejects(f.check(100));f.setStatus(status);await assert.rejects(f.check(7*HOUR));assert.equal(f.state.known[1].notFound,undefined);assert(f.state.known[1].active);}
  const f=fixture(t);await assert.rejects(f.check(100));f.setStatus(200);assert.equal(await f.check(7*HOUR),false);assert.equal(f.state.known[1].notFound,undefined);
});
test('an archive rediscovery cannot strand a retry behind a 30-day metadata deadline',t=>{
  const f=fixture(t);f.state.records[1]={complete:true,missingScans:0,nextCheckAt:30*24*HOUR};
  f.state.errors['item:1']={message:'HTTP 404',retryAt:HOUR};observe(f.state,card(1),100);
  const {status}=require('../scripts/pipeline');
  // Controls lack records, so compare the extra due item rather than absolute count.
  const before=status(f.state,HOUR-1,'details').pendingCount;
  assert.equal(status(f.state,HOUR,'details').pendingCount,before+1);
});
