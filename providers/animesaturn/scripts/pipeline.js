'use strict';
const collection=require('../../../shared/catalog/collection');
const path=require('node:path');
const {Client}=require('./http');
const {parseArchive,parseAnime,parseEpisode,parseFeed,parseHomeImages}=require('./parse');
const {DEFAULT_DATA,itemFile,read,write,hash,initialState,observe,publish}=require('./store');
const HOUR=3600000,DAY=24*HOUR;
const retryable=(error,now)=>!error||error.retryAt<=now;
const failure=(error,now)=>({message:String(error.message).slice(0,250),status:error.status||null,retryAt:now+HOUR});
const signature=page=>hash(page.cards.map(value=>[value.id,value.path]));
function recordDue(state,id,now){
  const known=state.known[id],record=state.records[id];
  return known.active && retryable(record?.error,now) && (!record?.complete || known.refresh || known.missingScans ||
    record.nextCheckAt<=now || state.fullSince && record.checkedAt<state.fullSince);
}
function workStatus(state,now,stage='all'){
  const ids=Object.keys(state.known).filter(id=>state.known[id].active);
  const pending=ids.filter(id=>recordDue(state,id,now));
  const archiveDue=Boolean(state.archive.scan)||!state.archive.completedAt||now-state.archive.completedAt>=DAY ||
    Boolean(state.fullSince&&state.archive.completedAt<state.fullSince);
  const feedDue=Boolean(state.feed.scan)||!state.feed.checkedAt||now-state.feed.checkedAt>=2*HOUR;
  const newestDue=Boolean(state.newest?.scan)||!state.newest?.checkedAt||now-state.newest.checkedAt>=2*HOUR;
  const discovery=archiveDue&&retryable(state.errors.archive,now)||feedDue&&retryable(state.errors.feed,now)||newestDue&&retryable(state.errors.newest,now);
  return {complete:Boolean(state.archive.completedAt)&&!state.archive.scan&&!discovery&&!pending.length&&
    !Object.keys(state.errors).length&&ids.every(id=>state.records[id]?.complete&&!state.records[id]?.error),
    pendingCount:pending.length,hasImmediateWork:stage==='publish'?false:stage==='discover'?Boolean(discovery):stage==='details'?!!pending.length:Boolean(discovery||pending.length)};
}
async function scanArchive(client,state,root,{now,pagesPerBatch,save}){
  if(!retryable(state.errors.archive,now)||!state.archive.scan&&state.archive.completedAt&&now-state.archive.completedAt<DAY&&
    (!state.fullSince||state.archive.completedAt>=state.fullSince))return;
  try{
    for(let n=0;n<pagesPerBatch;n++){
      let scan=state.archive.scan;
      if(scan&&scan.next>scan.pages){
        const first=parseArchive((await client.get('/az-list')).html,client.baseUrl,1,state.origins);
        const last=parseArchive((await client.get(`/az-list/${scan.pages}`)).html,client.baseUrl,scan.pages,state.origins);
        if(first.total!==scan.total||last.total!==scan.total||signature(first)!==scan.first||signature(last)!==scan.last||Object.keys(scan.ids).length!==scan.total)
          throw new Error('Archive changed or has duplicate/missing records');
        for(const known of Object.values(state.known)){
          if(!scan.ids[known.id]&&known.active&&known.lastSeenAt<scan.startedAt)known.missingScans=(known.missingScans||0)+1;
        }
        write(path.join(root,'archive.json'),{total:scan.total,ids:Object.keys(scan.ids),checkedAt:now});
        state.archive={completedAt:now,total:scan.total};delete state.errors.archive;save();return;
      }
      const page=scan?.next||1;
      const listing=parseArchive((await client.get(page===1?'/az-list':`/az-list/${page}`)).html,client.baseUrl,page,state.origins);
      if(!scan)scan=state.archive.scan={next:1,pages:listing.pages,total:listing.total,first:signature(listing),ids:{},startedAt:now};
      if(scan.total!==listing.total||scan.pages!==listing.pages)throw new Error('Archive total changed');
      for(const card of listing.cards){if(scan.ids[card.id])throw new Error('Archive repeated identity');scan.ids[card.id]=true;observe(state,card,now);}
      scan.next++;scan.last=signature(listing);save();
      console.log(`animesaturn archive: ${page}/${scan.pages}, ${Object.keys(scan.ids).length}/${scan.total}`);
    }
  }catch(error){if(client.signal?.aborted||/WARP_REQUIRED/.test(error.message))throw error;
    state.errors.archive=failure(error,now);if(/Archive|Invalid archive/.test(error.message))delete state.archive.scan;save();}
}
async function scanFeed(client,state,{now,pagesPerBatch,save}){
  if(!retryable(state.errors.feed,now)||!state.feed.scan&&state.feed.checkedAt&&now-state.feed.checkedAt<2*HOUR)return;
  try{
    for(let i=0;i<pagesPerBatch;i++){
      const scan=state.feed.scan||={page:1,anchors:state.feed.head||[],head:null,signatures:[]};
      const value=parseFeed((await client.get(`/api/home/episodes?page=${scan.page}`)).html,client.baseUrl,scan.page,state.origins);
      const keys=value.items.map(item=>item.episodePath),fingerprint=hash(keys);
      if(scan.signatures.includes(fingerprint))throw new Error('Repeated feed page');
      scan.signatures.push(fingerprint);scan.head ||= keys;
      value.items.forEach(card=>observe(state,card,now));
      const overlap=keys.filter(key=>scan.anchors.includes(key)).length;
      if(!scan.anchors.length||!value.hasNext||overlap>=Math.min(3,scan.anchors.length)){
        state.feed={head:scan.head,checkedAt:now};delete state.errors.feed;save();return;
      }
      scan.page++;save();
    }
  }catch(error){if(client.signal?.aborted||/WARP_REQUIRED/.test(error.message))throw error;
    state.errors.feed=failure(error,now);if(/Repeated|Invalid update feed/.test(error.message))delete state.feed.scan;save();}
}
async function scanNewest(client,state,{now,pagesPerBatch,save}){
  state.newest ||= {};
  if(!retryable(state.errors.newest,now)||!state.newest.scan&&state.newest.checkedAt&&now-state.newest.checkedAt<2*HOUR)return;
  try{
    for(let i=0;i<pagesPerBatch;i++){
      const scan=state.newest.scan||={page:1,anchors:state.newest.head||[],head:null,signatures:[]};
      const listing=parseArchive((await client.get(scan.page===1?'/newest':`/newest/${scan.page}`)).html,
        client.baseUrl,scan.page,state.origins,'Nuove aggiunte');
      const keys=listing.cards.map(item=>item.id),fingerprint=hash(keys);
      if(scan.signatures.includes(fingerprint))throw new Error('Repeated newest page');
      scan.signatures.push(fingerprint);scan.head ||= keys;
      listing.cards.forEach(card=>observe(state,card,now));
      if(!scan.anchors.length||scan.page===listing.pages||keys.filter(key=>scan.anchors.includes(key)).length>=Math.min(3,scan.anchors.length)){
        state.newest={head:scan.head,checkedAt:now};delete state.errors.newest;save();return;
      }scan.page++;save();
    }
  }catch(error){if(client.signal?.aborted||/WARP_REQUIRED/.test(error.message))throw error;
    state.errors.newest=failure(error,now);if(/Repeated|Invalid archive/.test(error.message))delete state.newest.scan;save();}
}
async function details(client,state,root,{now,requestLimit,save}){
  let remaining=requestLimit;
  for(const known of Object.values(state.known)){
    if(remaining<=0)break;
    if(!recordDue(state,known.id,now))continue;
    const status=state.records[known.id]||={episodeChecks:{}};
    if(collection.reuse(client,state,root,known.id,now,save))continue;
    try{
      let record=read(itemFile(root,known.id));const previous=record,sourceChanged=!!known.refresh;
      if(!record||!status.pageAt||status.complete||known.refresh){
        remaining--;
        let response;
        try{response=await client.get(known.path);}catch(error){
          if([404,410].includes(error.status)&&known.missingScans>=2&&status.missingConfirmedAt&&status.missingConfirmedAt<state.archive.completedAt){
            known.active=false;delete status.error;save();continue;
          }
          if([404,410].includes(error.status)&&known.missingScans)status.missingConfirmedAt=now;
          throw error;
        }
        const next=parseAnime(response.html,client.baseUrl,known,state.origins);
        const old=new Map((record?.episodes||[]).map(episode=>[episode.id,episode]));
        next.episodes=next.episodes.map(episode=>old.get(episode.id)?.path===episode.path?{...old.get(episode.id),...episode,
          publishedAt:old.get(episode.id).publishedAt,sourceMetadata:old.get(episode.id).sourceMetadata,images:old.get(episode.id).images}:episode);
        record=next;status.complete=false;status.pageAt=now;known.refresh=false;known.missingScans=0;
        delete status.missingConfirmedAt;write(itemFile(root,known.id),record);save();
      }
      const selection=collection.annotate(record,client,now,previous,sourceChanged);
      for(let index=0;selection.mode==='full'&&index<record.episodes.length&&remaining>0;index++){
        const episode=record.episodes[index],checked=status.episodeChecks[episode.id]||0;
        if(episode.sourceMetadata&&now-checked<30*DAY&&(!state.fullSince||checked>=state.fullSince))continue;
        remaining--;
        record.episodes[index]=parseEpisode((await client.get(episode.path)).html,client.baseUrl,record,episode,state.origins);
        status.episodeChecks[episode.id]=now;write(itemFile(root,known.id),record);save();
      }
      status.complete=selection.mode==='linked'||record.episodes.every(episode=>episode.sourceMetadata&&now-(status.episodeChecks[episode.id]||0)<30*DAY&&
        (!state.fullSince||status.episodeChecks[episode.id]>=state.fullSince));
      if(status.complete){status.checkedAt=now;status.nextCheckAt=now+(['completed','dropped'].includes(record.info.status)&&record.episodes.length?30*DAY:12*HOUR);}
      if(selection.mode==='linked')status.nextCheckAt=Math.min(status.nextCheckAt,now+DAY);
      write(itemFile(root,known.id),record);delete status.error;save();
    }catch(error){status.error=failure(error,now);save();if(client.signal?.aborted||/WARP_REQUIRED/.test(error.message))throw error;
      console.error(`animesaturn ${known.id}: ${error.message}`);}
  }
}
async function run({root=DEFAULT_DATA,mode='update',stage='all',requestLimit=50,pagesPerBatch=10,budgetMs=180000,client,now=Date.now()}={}){
  if(!['update','full'].includes(mode)||!['all','discover','details','publish'].includes(stage))throw new Error('Invalid mode/stage');
  const state=read(path.join(root,'state.json'),initialState()),save=()=>write(path.join(root,'state.json'),state);
  if(mode==='full'&&!state.fullSince)state.fullSince=now;
  client ||= new Client({signal:AbortSignal.timeout(budgetMs)});
  collection.configure(client,'animesaturn',root,state,now);
  let interrupted=false;
  try{
    if(stage!=='publish'){
      const discovery=await client.discover();state.origins.site=client.baseUrl;
      state.homeImages=parseHomeImages(discovery.html,client.baseUrl,state.origins);
      state.discovery={baseUrl:client.baseUrl,source:discovery.source,pastebin:discovery.pastebin};save();
      if(stage==='all'||stage==='discover'){
        await scanArchive(client,state,root,{now,pagesPerBatch,save});
        await scanFeed(client,state,{now,pagesPerBatch:5,save});
        await scanNewest(client,state,{now,pagesPerBatch:5,save});
      }
      if(stage==='all'||stage==='details')await details(client,state,root,{now,requestLimit,save});
      delete state.errors.connection;
    }
  }catch(error){state.errors.connection=failure(error,now);interrupted=true;save();}
  const status=workStatus(state,now,stage);
  if(status.complete&&state.fullSince){delete state.fullSince;save();}
  publish(root,state,status);return {...status,interrupted};
}
if(require.main===module)run({mode:process.env.RUN_MODE||'update',stage:process.env.RUN_STAGE||'all'})
  .then(result=>{console.log(`ANIMESATURN_BATCH ${JSON.stringify(result)}`);if(result.interrupted)process.exitCode=1;})
  .catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run,recordDue,workStatus,scanArchive,scanFeed,scanNewest,details};
