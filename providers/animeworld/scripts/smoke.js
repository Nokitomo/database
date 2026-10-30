'use strict';

// Explicit, bounded live validation. Never writes the production database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Client} = require('./http');
const {parseListing,parseAnime,parseTooltip,parseHomeImages,parseSchedule} = require('./parse');
const {initialState,observe,write,itemFile,publish} = require('./store');
const {verify} = require('./verify');

async function main() {
  const client=new Client({signal:AbortSignal.timeout(120000)}),home=await client.discover();
  const state=initialState();state.origins.site=client.baseUrl;
  const first=parseListing((await client.get('/az-list?page=1')).html,client.baseUrl,
    {archive:true,page:1,origins:state.origins});
  const second=parseListing((await client.get('/az-list?page=2')).html,client.baseUrl,
    {archive:true,page:2,origins:state.origins});
  const last=parseListing((await client.get(`/az-list?page=${first.pages}`)).html,client.baseUrl,
    {archive:true,page:first.pages,origins:state.origins});
  assert.equal(second.total,first.total);assert.equal(last.total,first.total);
  assert.ok(!second.cards.some(card=>first.cards.some(other=>other.id===card.id)));
  state.extras.images=parseHomeImages(home.html,client.baseUrl,state.origins);
  state.extras.schedule=parseSchedule((await client.get('/schedule')).html,client.baseUrl,state.origins);
  const samples=[first.cards[0],
    {id:160,code:'qzG-LE',path:'/play/one-piece-subita.qzG-LE'},
    {id:6947,code:'bNLAf',path:'/play/the-one-piece.bNLAf'}];
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'animeworld-live-'));
  try {
    for(const sample of samples) {
      observe(state,sample,Date.now());
      const record=parseAnime((await client.get(sample.path)).html,client.baseUrl,sample,state.origins);
      record.tooltip=parseTooltip((await client.get(`/api/tooltip/${sample.id}`)).html,client.baseUrl,sample,state.origins);
      state.records[sample.id]={pageAt:Date.now(),tooltipAt:Date.now()};
      write(itemFile(root,sample.id),record);
      console.log(JSON.stringify({id:record.id,title:record.info.title,status:record.info.status,
        episodes:record.episodes.length,declared:record.info.declaredEpisodeCount,
        images:record.images.length,related:record.related.length,tooltip:Boolean(record.tooltip)}));
    }
    write(path.join(root,'state.json'),state);
    publish(root,state,{complete:false,pendingCount:0});
    verify(root);
    console.log(JSON.stringify({success:true,domain:client.baseUrl,archiveReported:first.total,pages:first.pages,
      sampledRecords:samples.length,requests:client.requests,productionDataWritten:false,
      warpTested:process.env.WARP_REQUIRED==='1'}));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
