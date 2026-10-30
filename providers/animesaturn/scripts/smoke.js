'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Client}=require('./http');
const {parseArchive,parseAnime,parseEpisode}=require('./parse');
const {initialState,observe,write,itemFile,publish}=require('./store');
const {verify}=require('./verify');
async function smoke(){
  const client=new Client({signal:AbortSignal.timeout(120000)}),home=await client.discover(),state=initialState();
  state.origins.site=home.baseUrl;
  const first=parseArchive((await client.get('/az-list')).html,client.baseUrl,1,state.origins);
  const last=parseArchive((await client.get(`/az-list/${first.pages}`)).html,client.baseUrl,first.pages,state.origins);
  if(first.total!==last.total)throw new Error('Archive changed during smoke check');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'animesaturn-smoke-'));
  try{
    for(const card of [first.cards[0],last.cards[0]]){
      const record=parseAnime((await client.get(card.path)).html,client.baseUrl,card,state.origins);
      if(record.episodes.length)record.episodes[0]=parseEpisode((await client.get(record.episodes[0].path)).html,client.baseUrl,record,record.episodes[0],state.origins);
      observe(state,card,Date.now());write(itemFile(root,card.id),record);
      console.log(`${record.id}: ${record.info.title}; ${record.episodes.length} episodes`);
    }
    publish(root,state,{complete:false,pendingCount:2});console.log(verify(root));
    return {archiveTotal:first.total,pages:first.pages,requests:client.requests};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)smoke().then(console.log).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={smoke};
