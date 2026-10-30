'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Client}=require('./http'),{archive,detail}=require('./parse');
const {initialState,observe,publish}=require('./store'),{scanArchive,collect}=require('./pipeline'),{verify}=require('./verify');
async function smoke({fullArchive=false}={}){
  const client=new Client({signal:AbortSignal.timeout(fullArchive?30*60*1000:120000)}),d=await client.discover(),state=initialState();state.origins.site=d.baseUrl;
  const p=archive((await client.get('/api/v1/web/archive?offset=0&limit=30&count=1',true)).html);
  const last=archive((await client.get('/api/v1/web/archive?offset='+Math.floor((p.count-1)/30)*30+'&limit=30&count=1',true)).html);assert.equal(last.items.length,p.count%30||30);
  const samples=[p.items.find(x=>x.kind==='movie'),p.items.find(x=>x.kind==='series')].filter(Boolean);assert.equal(samples.length,2);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'altadefinizione-live-'));
  try{
    for(const card of samples){observe(state,card,Date.now());await collect(client,state,root,card.id,{now:Date.now(),save(){}});}
    const long=detail((await client.get('/serie-tv/30486-the-office-us-streaming.html')).html,30486,state.origins);assert(long.seasons.length>=9);assert(long.seasons.reduce((n,s)=>n+s.episodes.length,0)>100);
    publish(root,state,{complete:false,pendingCount:0});assert.equal(verify(root).count,2);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  if(fullArchive){while(!state.archive.completedAt){await scanArchive(client,state,{now:Date.now(),save(){},maxRequests:30});console.log('archive progress',Object.keys(state.archive.scan?.ids||state.known).length,state.archive.scan?.total||state.archive.total);}}
  console.log(JSON.stringify({ok:true,requests:client.requests,archiveTotal:p.count,covered:state.archive.total||null}));
}
if(require.main===module)smoke({fullArchive:process.argv.includes('--archive')}).catch(e=>{console.error(e);process.exitCode=1;});module.exports={smoke};
