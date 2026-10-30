'use strict';
// Explicit live inspection only. No production database writes or stream requests.
const assert=require('node:assert/strict');
const {Client}=require('./http');
const {archive,detail}=require('./parse');
const {initialState,observe,publish}=require('./store');
const {scanArchive,collect}=require('./pipeline');
const {verify}=require('./verify');
async function smoke({fullArchive=false}={}){
  const client=new Client({signal:AbortSignal.timeout(fullArchive?20*60*1000:120000)});
  const discovery=await client.discover(),state=initialState();state.origins={site:discovery.baseUrl,images:discovery.cdn};state.genres=discovery.genres;
  let a=archive((await client.get('/it/archive?type=movie&sort=created_at',true)).html);
  const film=a.data[0],movie=detail((await client.get('/it/titles/'+film.id+'-'+film.slug)).html,film.id,state.origins);
  assert.equal(movie.info.type,'movie');assert(movie.images.length);
  const tv=archive((await client.get('/it/archive?type=tv&sort=created_at',true)).html).data[0];
  const series=detail((await client.get('/it/titles/'+tv.id+'-'+tv.slug)).html,tv.id,state.origins);
  assert.equal(series.info.type,'tv');
  const other=series.seasonIndex.find(s=>s.number!==series.season?.number);
  if(other)detail((await client.get(series.path+'/season-'+other.number)).html,tv.id,state.origins,other.number);
  const year=new Date().getUTCFullYear()-1;
  const partition=archive((await client.get('/it/archive?year='+year,true)).html);
  if(partition.last_page<=20)archive((await client.get('/it/archive?year='+year+'&page='+partition.last_page,true)).html,partition.last_page);
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'streamingunity-live-'));
  try{
    const sample=initialState();sample.origins={...state.origins};
    for(const card of [film,tv]){
      observe(sample,card,Date.now());
      await collect(client,sample,root,card.id,{now:Date.now(),save(){},maxSeasons:100});
    }
    publish(root,sample,{complete:false,pendingCount:0});assert.equal(verify(root).count,2);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  if(fullArchive){
    let batches=0;
    while(!state.archive.completedAt){await scanArchive(client,state,{now:Date.now(),save(){},maxRequests:20});batches++;
      console.log(JSON.stringify({batches,requests:client.requests,known:Object.keys(state.known).length,total:state.archive.scan?.total||state.archive.total,partitions:state.archive.scan?.queue.length||0,residual:state.archive.scan?.candidateIndex}));}
    assert.equal(Object.keys(state.known).length,state.archive.total);
  }
  return {requests:client.requests,movie:movie.info.name,series:series.info.name,episodeCount:series.season?.episodes.length,archiveTotal:state.archive.total||null};
}
if(require.main===module)smoke({fullArchive:process.argv.includes('--archive')}).then(console.log).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={smoke};
