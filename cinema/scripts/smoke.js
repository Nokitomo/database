'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {run}=require('./pipeline'),{verify}=require('./verify'),{read}=require('../../shared/storage/json');
async function smoke(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-live-')),roots={};
  try{
    const samples={streamingunity:[{id:66402,slug:'yaga'},{id:66464,slug:'sacrifice'}],altadefinizione:[{id:45321,slug:'yaga',kind:'series'},{id:45364,slug:'sacrifice',kind:'movie'}]};
    for(const provider of Object.keys(samples)){
      const {Client}=require(`../../providers/${provider}/scripts/http`),{collect}=require(`../../providers/${provider}/scripts/pipeline`),store=require(`../../providers/${provider}/scripts/store`);
      const client=new Client({signal:AbortSignal.timeout(120000)}),d=await client.discover(),state=store.initialState();state.origins={site:d.baseUrl};if(d.cdn)state.origins.images=d.cdn;
      roots[provider]=path.join(root,provider);
      for(const card of samples[provider]){store.observe(state,card,Date.now());await collect(client,state,roots[provider],card.id,{now:Date.now(),save(){},maxSeasons:100});}
      store.publish(roots[provider],state,{complete:false,pendingCount:0});
    }
    const output=path.join(root,'cinema');const result=await run({roots,output,stage:'merge'});assert.equal(result.count,3);verify(output);
    const manifest=read(path.join(output,'manifest.json')),items=Object.keys(manifest.itemHashes).map(id=>read(path.join(output,'items',id+'.json'))),yaga=items.find(r=>r.sourceIds.tmdb==='314360');
    assert(yaga.providers.streamingunity?.length&&yaga.providers.altadefinizione?.length);
    assert(yaga.seasons[0].episodes.some(e=>e.metadataSources['streamingunity:66402']&&e.metadataSources['altadefinizione:45321']));
    console.log(JSON.stringify({ok:true,records:result.count,matched:{title:yaga.info.title,ids:yaga.sourceIds},sacrifices:items.filter(r=>r.info.title==='Sacrifice').map(r=>r.sourceIds),episodes:yaga.seasons[0].episodes.map(e=>({number:e.number,title:e.title,synopsis:!!e.synopsis,thumbnail:!!e.thumbnail}))}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)smoke().catch(e=>{console.error(e);process.exitCode=1;});module.exports={smoke};
