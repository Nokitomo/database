'use strict';
const collection=require('../../../shared/catalog/collection');
const path=require('node:path');
const {Client}=require('./http');
const {ARCHIVE,archive,indexLinks,connectedPage,detail}=require('./parse');
const {localPath,reference}=require('./urls');
const {read,write,hash,DEFAULT_DATA,itemFile,initialState,observe,publish}=require('./store');
const HOUR=3600000,DAY=24*HOUR,WEEK=7*DAY;
const INDEXES=['/elenco-serie-tv/','/elenco-serie-tv-seconda-parte/','/elenco-z-anime-cartoni/'];
const archivePath=n=>ARCHIVE+(n>1?`page/${n}/`:'');
const signature=p=>hash(p.items.map(c=>[c.id,c.path]));
const retry=(s,k,now)=>!s.errors[k]||s.errors[k].retryAt<=now;
function queue(state,p,now,refresh=false){
  const k=Object.values(state.known).find(k=>k.path===p||k.aliases?.includes(p));
  if(k){k.lastSeenAt=now;k.missingScans=0;if(!k.active||refresh)k.refresh=true;if(refresh)k.lastUpdateSeenAt=now;k.active=true;}
  else state.paths[p]||={addedAt:now};
}
function due(s,id,now){const k=s.known[id],r=s.records[id];return k.active&&retry(s,'item:'+id,now)&&(!r?.complete||k.refresh||r.nextCheckAt<=now||r.missingScans!==(k.missingScans||0)||s.fullSince&&r.checkedAt<s.fullSince);}
function status(s,now,stage){
  const pending=Object.keys(s.known).filter(id=>due(s,id,now));
  const paths=Object.keys(s.paths).filter(p=>retry(s,'path:'+p,now));
  const discovery=retry(s,'archive',now)&&(!s.archive.completedAt||s.archive.scan||now-s.archive.completedAt>=WEEK||s.fullSince&&s.archive.completedAt<s.fullSince);
  const feeds=retry(s,'feed',now)&&(!s.feeds.checkedAt||now-s.feeds.checkedAt>=2*HOUR);
  return {complete:!!s.archive.completedAt&&!s.archive.scan&&!Object.keys(s.paths).length&&!pending.length&&!Object.keys(s.errors).length&&Object.values(s.known).filter(k=>k.active).every(k=>s.records[k.id]?.complete),
    pendingCount:pending.length+Object.keys(s.paths).length,hasImmediateWork:stage==='publish'?false:stage==='discover'?!!(discovery||feeds):stage==='details'?!!(pending.length||paths.length):!!(discovery||feeds||pending.length||paths.length)};
}
async function scanArchive(client,s,{now,save,maxRequests=20}){
  if(!retry(s,'archive',now)||!s.archive.scan&&s.archive.completedAt&&now-s.archive.completedAt<WEEK&&(!s.fullSince||s.archive.completedAt>=s.fullSince))return;
  if(s.archive.scan&&now-s.archive.scan.startedAt>DAY)delete s.archive.scan;
  for(let n=0;n<maxRequests;n++){
    let scan=s.archive.scan;
    if(!scan||scan.page<=scan.pages){
      const page=scan?.page||1,p=archive((await client.get(archivePath(page))).html,client.baseUrl,page);
      scan=s.archive.scan||={page:1,pages:p.pages,first:signature(p),ids:{},paths:{},index:0,startedAt:now};
      if(scan.pages!==p.pages)throw Error('Archive changed page count');
      for(const card of p.items){if(scan.ids[card.id])throw Error('Archive repeated ID');scan.ids[card.id]=true;scan.paths[card.path]=true;observe(s,card,now);}
      scan.page++;save();continue;
    }
    if(scan.index<INDEXES.length){
      const links=indexLinks((await client.get(INDEXES[scan.index])).html,client.baseUrl,'index');
      for(const p of links){scan.paths[p]=true;queue(s,p,now);}
      scan.index++;save();continue;
    }
    const first=archive((await client.get(archivePath(1))).html,client.baseUrl,1);
    if(first.pages!==scan.pages||signature(first)!==scan.first)throw Error('Archive changed during scan');
    for(const k of Object.values(s.known))if(k.active&&!scan.ids[k.id]&&!scan.paths[k.path]&&!k.aliases?.some(p=>scan.paths[p])&&k.lastSeenAt<scan.startedAt)k.missingScans=(k.missingScans||0)+1;
    s.archive={completedAt:now,total:Object.keys(scan.ids).length,indexPathCount:Object.keys(scan.paths).length};delete s.errors.archive;save();return;
  }
}
async function scanFeed(client,s,{now,save}){
  if(!retry(s,'feed',now)||s.feeds.checkedAt&&now-s.feeds.checkedAt<2*HOUR)return;
  const links=indexLinks((await client.get('/nuovi-ep-aggiornamento/')).html,client.baseUrl,'updates');
  links.forEach(p=>queue(s,p,now,true));s.feeds={checkedAt:now};delete s.errors.feed;save();
}
async function collect(client,s,root,p,id,{now,save}){
  if(id!=null){const cached=collection.reuse(client,s,root,id,now,save);if(cached)return cached;}
  let page;try{page=await client.get(p);}catch(e){e.mainPageUnavailable=[404,410].includes(e.status);throw e;}
  const actual=localPath(page.url||p,client.baseUrl),connected=connectedPage(page.html,client.baseUrl);
  if(connected===actual)throw Error('Episode page cycle');
  const origins={...s.origins},identity=detail(page.html,id,origins,actual,null,{identityOnly:true});
  const previous=read(itemFile(root,identity.id)),sourceChanged=!!s.known[identity.id]?.refresh,selection=collection.annotate(identity,client,now,previous,sourceChanged);
  const episodePage=connected&&selection.mode==='full'?await client.get(connected):null;
  const record=selection.mode==='linked'?identity:detail(page.html,id,origins,actual,episodePage?.html);
  if(selection.mode==='linked'&&connected&&previous){record.seasons=previous.seasons;record.seasonIndex=previous.seasonIndex;record.episodeBlocks=previous.episodeBlocks;}
  collection.annotate(record,client,now,previous,sourceChanged);
  // Keep the archive's poster too; detail artwork may come from another CDN.
  const prior=s.known[record.id],cardImage=prior?.card?.image;
  if(cardImage){const ref=reference(cardImage,origins);if(!record.images.some(i=>hash(i.reference)===hash(ref)))record.images.push({role:'poster',reference:ref,language:null});}
  s.origins=origins;
  if(!prior)observe(s,{id:record.id,path:actual,name:record.info.name},now);
  const k=s.known[record.id];k.path=actual;k.active=true;k.refresh=false;
  // A redirect alias discovered by an auxiliary index belongs to this same work.
  k.aliases=[...new Set([...(k.aliases||[]),p,actual])];
  const priorRecord=read(itemFile(root,record.id)),changed=!priorRecord||hash(priorRecord)!==hash(record);
  if(changed)k.lastChangedAt=now;
  const recent=Math.max(k.lastChangedAt||0,k.lastUpdateSeenAt||0)>=now-7*DAY;
  write(itemFile(root,record.id),record);s.records[record.id]={complete:true,checkedAt:now,missingScans:k.missingScans||0,nextCheckAt:now+(recent?DAY:WEEK)};
  for(const alias of k.aliases){delete s.paths[alias];delete s.errors['path:'+alias];}
  delete s.errors['item:'+record.id];save();return record;
}
async function run({root=DEFAULT_DATA,client=new Client(),mode='update',stage='all',now=Date.now(),budgetMs=180000,maxRequests=20,maxItems=20}={}){
  if(!['update','full'].includes(mode)||!['all','discover','details','publish'].includes(stage))throw Error('Invalid run options');
  const s=read(path.join(root,'state.json'))||initialState(),save=()=>write(path.join(root,'state.json'),s);
  s.paths||={};if(mode==='full'&&!s.fullSince){s.fullSince=now;s.archive.completedAt=0;}
  collection.configure(client,'eurostreaming',root,s,now);
 const start=Date.now();client.signal||=AbortSignal.timeout(budgetMs);let fatal=null;
  const attempt=async(key,fn)=>{try{await fn();}catch(e){s.errors[key]={message:String(e.message).slice(0,250),retryAt:now+HOUR};
    if(key==='archive'&&/changed|repeated|Incomplete/i.test(e.message))delete s.archive.scan;save();
    if(client.signal.aborted||/WARP_REQUIRED/.test(e.message))throw e;}};
  try{
    if(stage!=='publish'){
      const d=await client.discover();s.origins.site=d.baseUrl;s.discovery=d;delete s.errors.discovery;save();
      if(stage==='all'||stage==='discover'){
        await attempt('archive',()=>scanArchive(client,s,{now,save,maxRequests}));
        await attempt('feed',()=>scanFeed(client,s,{now,save}));
      }
      if(stage==='all'||stage==='details'){
        let processed=0;
        for(const id of Object.keys(s.known).filter(id=>due(s,id,now))){
          if(processed>=maxItems||Date.now()-start>=budgetMs-1000)break;processed++;
          await attempt('item:'+id,async()=>{const k=s.known[id];
            try{await collect(client,s,root,k.path,id,{now,save});}
            catch(e){if(k.missingScans>=2&&e.mainPageUnavailable){k.active=false;delete s.errors['item:'+id];save();return;}throw e;}
          });
        }
        for(const p of Object.keys(s.paths).filter(p=>retry(s,'path:'+p,now))){
          if(processed>=maxItems||Date.now()-start>=budgetMs-1000)break;processed++;
          await attempt('path:'+p,()=>collect(client,s,root,p,null,{now,save}));
        }
      }
    }
  }catch(e){fatal=e.message;s.errors.discovery={message:String(e.message).slice(0,250),retryAt:now+HOUR};save();}
  const result=status(s,now,stage);if(result.complete&&!result.hasImmediateWork)delete s.fullSince;
  save();const m=publish(root,s,result);
  console.log('EUROSTREAMING_BATCH '+JSON.stringify({...result,fatal,expected:m.expectedCount,available:m.availableCount,archivePage:s.archive.scan?.page,archivePages:s.archive.scan?.pages,errors:Object.keys(s.errors)}));
  return {...result,fatal,state:s};
}
if(require.main===module)run({mode:process.env.RUN_MODE||'update',stage:process.env.RUN_STAGE||'all'}).then(r=>{if(r.fatal)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run,scanArchive,scanFeed,collect,status,archivePath,INDEXES,queue};
