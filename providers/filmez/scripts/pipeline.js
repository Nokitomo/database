'use strict';
const collection=require('../../../shared/catalog/collection');
const path=require('node:path');
const {Client}=require('./http'),{apiArchive,htmlArchive,detail}=require('./parse');
const {read,write,hash,DEFAULT_DATA,itemFile,initialState,observe,publish}=require('./store');
const KINDS=['movie'],HOUR=3600000,DAY=24*HOUR,WEEK=7*DAY;
const htmlPath=(kind,page=1)=>(kind==='movie'?'/movies/':'/serie-tv/')+(page>1?`page/${page}/`:'');
const apiPath=(kind,page=1,order='id')=>`/wp-json/wp/v2/${kind}?`+new URLSearchParams({per_page:'100',page:String(page),orderby:order,order:order==='id'?'asc':'desc',_fields:'id,link,title,type,modified_gmt,date_gmt'});
const signature=p=>hash(p.items.map(i=>[i.id,i.path]));
const retry=(s,k,now)=>!s.errors[k]||s.errors[k].retryAt<=now;
async function page(client,kind,n,mode,order='id'){const r=await client.get(mode==='api'?apiPath(kind,n,order):htmlPath(kind,n));return mode==='api'?apiArchive(r,client.baseUrl,kind,n):htmlArchive(r.html,client.baseUrl,kind,n);}
function due(s,id,now){const k=s.known[id],r=s.records[id];return k.active&&retry(s,'item:'+id,now)&&(!r?.complete||k.refresh||r.missingScans!==(k.missingScans||0)||r.nextCheckAt<=now||s.fullSince&&r.checkedAt<s.fullSince);}
function status(s,now,stage){const pending=Object.keys(s.known).filter(id=>due(s,id,now)),discovery=retry(s,'archive',now)&&(!s.archive.completedAt||s.archive.scan||now-s.archive.completedAt>=WEEK||s.fullSince&&s.archive.completedAt<s.fullSince);
 const feed=KINDS.some(k=>retry(s,'feed:'+k,now)&&(!s.feeds[k]?.checkedAt||now-s.feeds[k].checkedAt>=2*HOUR||s.feeds[k].scan));
 return {complete:!!s.archive.completedAt&&!s.archive.scan&&!pending.length&&!Object.keys(s.errors).length&&Object.values(s.known).filter(k=>k.active).every(k=>s.records[k.id]?.complete),pendingCount:pending.length,
 hasImmediateWork:stage==='publish'?false:stage==='discover'?!!(discovery||feed):stage==='details'?!!pending.length:!!(discovery||feed||pending.length)};}
async function scanArchive(client,s,{now,save,maxRequests=20}){
 if(!retry(s,'archive',now)||!s.archive.scan&&s.archive.completedAt&&now-s.archive.completedAt<WEEK&&(!s.fullSince||s.archive.completedAt>=s.fullSince))return;
 if(s.archive.scan&&now-s.archive.scan.startedAt>DAY)delete s.archive.scan;
 const scan=s.archive.scan||={startedAt:now,kinds:{},ids:{}};
 for(let n=0;n<maxRequests;n++){
  const kind=KINDS.find(k=>!scan.kinds[k]?.complete);
  if(!kind){for(const k of Object.values(s.known))if(k.active&&!scan.ids[k.id]&&k.lastSeenAt<scan.startedAt)k.missingScans=(k.missingScans||0)+1;
   s.archive={completedAt:now,total:Object.keys(scan.ids).length,counts:Object.fromEntries(KINDS.map(k=>[k,scan.kinds[k].total]))};delete s.errors.archive;save();return;}
  let cursor=scan.kinds[kind];
  if(!cursor){let p,mode='api';try{p=await page(client,kind,1,mode);}catch(e){if(client.signal?.aborted||/WARP_REQUIRED/.test(e.message))throw e;mode='html';p=await page(client,kind,1,mode);}
   cursor=scan.kinds[kind]={mode,page:1,pages:p.pages,total:p.total,first:signature(p),ids:{}};
   // Fetching page one again below avoids persisting an unverified partial object.
  }
  if(cursor.page>cursor.pages){
   const first=await page(client,kind,1,cursor.mode),last=await page(client,kind,cursor.pages,cursor.mode);
   const cross=htmlArchive((await client.get(htmlPath(kind))).html,client.baseUrl,kind,1);
   if(first.total!==cursor.total||last.total!==cursor.total||cross.total!==cursor.total||signature(first)!==cursor.first||signature(last)!==cursor.last||Object.keys(cursor.ids).length!==cursor.total)throw Error('Archive changed or coverage mismatch');
   cursor.complete=true;save();continue;
  }
  const p=await page(client,kind,cursor.page,cursor.mode);if(p.total!==cursor.total||p.pages!==cursor.pages)throw Error('Archive changed count');
  for(const card of p.items){if(scan.ids[card.id])throw Error('Archive repeated ID');scan.ids[card.id]=true;cursor.ids[card.id]=true;observe(s,card,now);}
  cursor.last=signature(p);cursor.page++;save();
 }
}
async function scanFeed(client,s,kind,{now,save,maxRequests=3}){
 if(!retry(s,'feed:'+kind,now))return;const prior=s.feeds[kind]||={};if(!prior.scan&&prior.checkedAt&&now-prior.checkedAt<2*HOUR)return;
 for(let i=0;i<maxRequests;i++){
  const c=prior.scan||={page:1,head:null,seen:[]};let p;
  try{p=await page(client,kind,c.page,'api','modified');}catch(e){if(client.signal?.aborted||/WARP_REQUIRED/.test(e.message))throw e;
   const fallback=await page(client,kind,1,'html');fallback.items.forEach(card=>observe(s,card,now));s.feeds[kind]={checkedAt:now,mode:'html-head',apiUnavailable:true};save();delete s.errors['feed:'+kind];return;}
  const keys=p.items.map(c=>c.id+':'+c.modified),fp=hash(keys);if(c.seen.includes(fp))throw Error('Repeated modified feed');c.seen.push(fp);c.head||=keys;
  p.items.forEach(card=>observe(s,card,now));
  if(!prior.head?.length||keys.some(k=>prior.head.includes(k))||c.page>=p.pages){s.feeds[kind]={checkedAt:now,head:c.head,mode:'api'};delete s.errors['feed:'+kind];save();return;}
  c.page++;save();
 }
}
async function collect(client,s,root,id,{now,save}){
 const cached=collection.reuse(client,s,root,id,now,save);if(cached)return cached;
 const k=s.known[id],response=await client.get(k.path),origins={...s.origins};
 let record;try{record=detail(response.html,id,origins,k.path,k.card.kind);}catch(e){if(e.message!=='Invalid detail identity')throw e;record=await require('./metadata').resolveAlias(client,response.html,id,origins,k.path);}
 const old=read(itemFile(root,id));
 const selection=collection.annotate(record,client,now,old,!!k.refresh);
 try{if(selection.mode==='full')await require('./metadata').supplement(client,record,origins);}catch(e){if(client.signal?.aborted||/WARP_REQUIRED/.test(e.message))throw e;record.metadataComplete=false;record.warnings.push('detail-api-retry');record.metadataError=String(e.message).slice(0,250);}
 if(!record.metadataComplete){
  if(!old||old.metadataComplete===false){s.origins=origins;write(itemFile(root,id),record);s.records[id]={complete:false,checkedAt:now,nextCheckAt:now+HOUR};save();}
  throw Error('Incomplete source metadata; previous complete record retained: '+(record.metadataError||record.warnings.join(', ')));
 }
 const changed=!old||hash(old)!==hash(record);if(changed)k.lastChangedAt=now;
 s.origins=origins;write(itemFile(root,id),record);
 const recent=(k.lastChangedAt||0)>=now-WEEK;s.records[id]={complete:true,checkedAt:now,missingScans:k.missingScans||0,nextCheckAt:now+(recent?DAY:WEEK)};
 k.refresh=false;delete s.errors['item:'+id];save();return record;
}
async function run({root=DEFAULT_DATA,client=new Client(),mode='update',stage='all',now=Date.now(),budgetMs=180000,maxRequests=20,maxItems=20}={}){
 if(!['update','full'].includes(mode)||!['all','discover','details','publish'].includes(stage))throw Error('Invalid run options');
 const s=read(path.join(root,'state.json'))||initialState(),save=()=>write(path.join(root,'state.json'),s);if(mode==='full'&&!s.fullSince){s.fullSince=now;s.archive.completedAt=0;}
 collection.configure(client,'filmez',root,s,now);
 const start=Date.now();client.signal||=AbortSignal.timeout(budgetMs);let fatal=null;
 const attempt=async(key,fn)=>{try{await fn();}catch(e){s.errors[key]={message:String(e.message).slice(0,250),retryAt:now+HOUR};
  if(key==='archive'&&/changed|repeated|coverage|Incomplete|Invalid/i.test(e.message))delete s.archive.scan;
  if(key.startsWith('feed:'))delete s.feeds[key.slice(5)]?.scan;save();if(client.signal.aborted||/WARP_REQUIRED/.test(e.message))throw e;}};
 try{if(stage!=='publish'){
  const d=await client.discover(s.origins.site);s.origins.site=d.baseUrl;s.discovery=d;delete s.errors.discovery;save();
  if(stage==='all'||stage==='discover'){await attempt('archive',()=>scanArchive(client,s,{now,save,maxRequests}));for(const kind of KINDS)await attempt('feed:'+kind,()=>scanFeed(client,s,kind,{now,save}));}
  if(stage==='all'||stage==='details')for(const id of Object.keys(s.known).filter(id=>due(s,id,now)).slice(0,maxItems)){
   if(Date.now()-start>=budgetMs-1000)break;
   await attempt('item:'+id,async()=>{const k=s.known[id];try{await collect(client,s,root,id,{now,save});}catch(e){if(k.missingScans>=2&&[404,410].includes(e.status)){k.active=false;delete s.errors['item:'+id];save();return;}throw e;}});
  }
 }}catch(e){fatal=e.message;s.errors.discovery={message:String(e.message).slice(0,250),retryAt:now+HOUR};save();}
 const result=status(s,now,stage);if(result.complete&&!result.hasImmediateWork)delete s.fullSince;save();const m=publish(root,s,result);
 console.log('FILMEZ_BATCH '+JSON.stringify({...result,fatal,expected:m.expectedCount,available:m.availableCount,archive:s.archive.scan?Object.fromEntries(Object.entries(s.archive.scan.kinds).map(([k,v])=>[k,{page:v.page,pages:v.pages,mode:v.mode}])):s.archive.counts,errors:Object.keys(s.errors)}));return {...result,fatal,state:s};
}
if(require.main===module)run({mode:process.env.RUN_MODE||'update',stage:process.env.RUN_STAGE||'all'}).then(r=>{if(r.fatal)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run,scanArchive,scanFeed,collect,status,apiPath,htmlPath};
