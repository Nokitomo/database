'use strict';
const path=require('node:path');
const {Client}=require('./http');
const {archive,detail}=require('./parse');
const {read,write,hash,DEFAULT_DATA,itemFile,initialState,observe,publish}=require('./store');
function archivePath(offset=0,sort='Data di aggiunta'){return '/api/v1/web/archive?'+new URLSearchParams({offset:String(offset),limit:'30',count:'1',sort});}
const signature=p=>hash(p.items.map(x=>[x.id,x.slug]));
async function page(client,offset,sort){const p=archive((await client.get(archivePath(offset,sort),true)).html);
  if(p.items.length!==Math.max(0,Math.min(30,p.count-offset)))throw Error('Incomplete archive page');return p;}
const HOUR=3600000,DAY=24*HOUR,WEEK=7*DAY;
const retry=(state,key,now)=>!state.errors[key]||state.errors[key].retryAt<=now;
function due(state,id,now){const k=state.known[id],r=state.records[id];return k.active&&retry(state,'item:'+id,now)&&(!r?.complete||k.refresh||r.missingScans!==(k.missingScans||0)||r.nextCheckAt<=now||state.fullSince&&r.checkedAt<state.fullSince);}
function status(state,now,stage){const pending=Object.keys(state.known).filter(id=>due(state,id,now));
  const discover=(!state.archive.completedAt||state.archive.scan||now-state.archive.completedAt>=WEEK||state.fullSince&&state.archive.completedAt<state.fullSince)&&retry(state,'archive',now);
  const feeds=['Data di aggiunta','Data di aggiornamento'].some(key=>(!state.feeds[key]?.checkedAt||now-state.feeds[key].checkedAt>=2*HOUR||state.feeds[key].scan)&&retry(state,'feed:'+key,now));
  return {complete:!!state.archive.completedAt&&!state.archive.scan&&!pending.length&&!Object.keys(state.errors).length&&Object.values(state.known).filter(k=>k.active).every(k=>state.records[k.id]?.complete),
    pendingCount:pending.length,hasImmediateWork:stage==='publish'?false:stage==='discover'?!!(discover||feeds):stage==='details'?!!pending.length:!!(discover||feeds||pending.length)};}

async function scanArchive(client,state,{now,save,maxRequests=20}) {
  if(!retry(state,'archive',now)||!state.archive.scan&&state.archive.completedAt&&now-state.archive.completedAt<WEEK&&(!state.fullSince||state.archive.completedAt>=state.fullSince))return;
  if(state.archive.scan&&now-state.archive.scan.startedAt>DAY)delete state.archive.scan;
  for(let n=0;n<maxRequests;n++){
    const offset=state.archive.scan?.offset||0,p=await page(client,offset);
    const s=state.archive.scan||={offset:0,total:p.count,first:signature(p),ids:{},startedAt:now};
    if(p.count!==s.total)throw Error('Archive changed total');
    for(const card of p.items){if(s.ids[card.id])throw Error('Archive repeated ID');s.ids[card.id]=true;observe(state,card,now);}
    if(offset+p.items.length>=p.count){
      const check=await page(client,0);
      if(check.count!==s.total||signature(check)!==s.first||Object.keys(s.ids).length!==s.total)throw Error('Archive changed or coverage mismatch');
      // An unexpected empty catalog cannot retire a previously populated source.
      if(!s.total&&Object.values(state.known).some(k=>k.active))throw Error('Empty archive after populated snapshot');
      for(const k of Object.values(state.known))if(k.active&&!s.ids[k.id]&&k.lastSeenAt<s.startedAt)k.missingScans=(k.missingScans||0)+1;
      state.archive={total:s.total,completedAt:now};delete state.errors.archive;save();return;
    }
    s.offset+=p.items.length;save();
  }
}
async function scanFeed(client,state,key,{now,save,maxRequests=3}){
  if(!retry(state,'feed:'+key,now))return;
  const prior=state.feeds[key]||={};if(!prior.scan&&prior.checkedAt&&now-prior.checkedAt<2*HOUR)return;
  for(let n=0;n<maxRequests;n++){
    const s=prior.scan||={offset:0,head:null,seen:[]},p=await page(client,s.offset,key),ids=p.items.map(x=>x.id),fp=signature(p);
    if(s.seen.includes(fp))throw Error('Repeated update page');s.seen.push(fp);s.head ||= ids;
    // Every item in the update window is refreshed: archive cards can stay the
    // same while episode plots or inventories change.
    p.items.forEach(card=>{observe(state,card,now);if(key==='Data di aggiornamento')state.known[card.id].refresh=true;});
    if(!prior.head?.length||ids.some(id=>prior.head.includes(id))||s.offset+p.items.length>=p.count){state.feeds[key]={head:s.head,checkedAt:now};delete state.errors['feed:'+key];save();return;}
    s.offset+=p.items.length;save();
  }
}
async function collect(client,state,root,id,{now,save}){
  const k=state.known[id],origins={...state.origins};
  const record=detail((await client.get(k.path)).html,id,origins);
  state.origins=origins;write(itemFile(root,id),record);
  const stable=!record.info.upcoming&&(record.info.type==='movie'||/ended|canceled|cancelled/i.test(record.info.status||''));
  state.records[id]={complete:true,checkedAt:now,missingScans:k.missingScans||0,nextCheckAt:now+(stable?30*DAY:DAY)};
  k.refresh=false;delete state.errors['item:'+id];save();
}
async function run({root=DEFAULT_DATA,client=new Client(),mode='update',stage='all',now=Date.now(),budgetMs=180000,maxRequests=20,maxItems=20}={}){
  if(!['update','full'].includes(mode)||!['all','discover','details','publish'].includes(stage))throw Error('Invalid run options');
  const state=read(path.join(root,'state.json'))||initialState(),save=()=>write(path.join(root,'state.json'),state);
  if(mode==='full'&&!state.fullSince){state.fullSince=now;state.archive.completedAt=0;}
  const started=Date.now();client.signal ||= AbortSignal.timeout(budgetMs);let fatal=null;
  const attempt=async(key,fn)=>{try{await fn();}catch(e){state.errors[key]={message:String(e.message).slice(0,300),retryAt:now+HOUR};
    if(key==='archive'&&/changed|repeated|mismatch|Incomplete|Empty/i.test(e.message))delete state.archive.scan;
    if(key.startsWith('feed:'))delete state.feeds[key.slice(5)]?.scan;
    save();if(client.signal?.aborted||/WARP_REQUIRED/.test(e.message))throw e;}};
  try{
    if(stage!=='publish'){
      const d=await client.discover();if(d.images)state.origins.images=d.images;
      state.origins.site=d.baseUrl;state.discovery=d;delete state.errors.discovery;save();
      if(stage==='all'||stage==='discover'){
        await attempt('archive',()=>scanArchive(client,state,{now,save,maxRequests}));
        for(const key of ['Data di aggiunta','Data di aggiornamento'])await attempt('feed:'+key,()=>scanFeed(client,state,key,{now,save}));
      }
      if(stage==='all'||stage==='details')for(const id of Object.keys(state.known).filter(id=>due(state,id,now)).slice(0,maxItems)){
        if(Date.now()-started>=budgetMs-1000)break;
        await attempt('item:'+id,async()=>{
          const k=state.known[id];if(k.missingScans>=2)try{await client.get(k.path);}catch(e){if([404,410].includes(e.status)){k.active=false;delete state.errors['item:'+id];save();return;}throw e;}
          await collect(client,state,root,id,{now,save});
        });
      }
    }
  }catch(e){fatal=e.message;state.errors.discovery={message:String(e.message).slice(0,300),retryAt:now+HOUR};save();}
  const result=status(state,now,stage);if(result.complete&&!result.hasImmediateWork)delete state.fullSince;
  save();const manifest=publish(root,state,result);
  console.log('ALTADEFINIZIONE_BATCH '+JSON.stringify({...result,fatal,expected:manifest.expectedCount,available:manifest.availableCount,archiveTotal:state.archive.scan?.total??state.archive.total??null,archiveKnown:state.archive.scan?Object.keys(state.archive.scan.ids).length:null,errors:Object.keys(state.errors)}));
  return {...result,fatal,state};
}
if(require.main===module)run({mode:process.env.RUN_MODE||'update',stage:process.env.RUN_STAGE||'all'}).then(r=>{if(r.fatal)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run,scanArchive,scanFeed,collect,status,archivePath};
