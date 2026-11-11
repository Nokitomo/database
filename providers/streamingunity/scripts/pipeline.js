'use strict';
const path=require('node:path');
const {Client}=require('./http');
const {cardFingerprint}=require('./card-fingerprint');
const {archive,detail,sitemap}=require('./parse');
const {read,write,hash,DEFAULT_DATA,itemFile,initialState,observe,publish}=require('./store');
const HOUR=3600000,DAY=24*HOUR,WEEK=7*DAY;
function archivePath(filters={},page=1){return '/it/archive?'+new URLSearchParams({sort:'created_at',...filters,page:String(page)});}
const signature=p=>hash(p.data.map(x=>[x.id,x.slug]));
const retry=(state,key,now)=>!state.errors[key]||state.errors[key].retryAt<=now;
function due(state,id,now){const k=state.known[id],r=state.records[id];return k.active&&retry(state,'item:'+id,now)&&(!!state.errors['item:'+id]||!r?.complete||k.refresh||r.missingScans!==(k.missingScans||0)||r.nextCheckAt<=now||state.fullSince&&r.checkedAt<state.fullSince);}
function status(state,now,stage){const pending=Object.keys(state.known).filter(id=>due(state,id,now));
  const discover=(!state.archive.completedAt||state.archive.scan||now-state.archive.completedAt>=WEEK||state.fullSince&&state.archive.completedAt<state.fullSince)&&retry(state,'archive',now);
  const feeds=['created_at','last_air_date'].some(key=>(!state.feeds[key]?.checkedAt||now-state.feeds[key].checkedAt>=2*HOUR||state.feeds[key].scan)&&retry(state,'feed:'+key,now));
  return {complete:!!state.archive.completedAt&&!state.archive.scan&&!pending.length&&!Object.keys(state.errors).length&&Object.values(state.known).filter(k=>k.active).every(k=>state.records[k.id]?.complete),
    pendingCount:pending.length,hasImmediateWork:stage==='publish'?false:stage==='discover'?!!(discover||feeds):stage==='details'?!!pending.length:!!(discover||feeds||pending.length)};}
async function scanArchive(client,state,{now,save,maxRequests=20,minYear=1910,maxYear=new Date(now).getUTCFullYear()}){
  if(!retry(state,'archive',now)||!state.archive.scan&&state.archive.completedAt&&now-state.archive.completedAt<WEEK&&(!state.fullSince||state.archive.completedAt>=state.fullSince))return;
  const get=async(filters,page=1)=>archive((await client.get(archivePath(filters,page),true)).html,page);
  if(!state.archive.scan){const first=await get({sort:'created_at'});state.archive.scan={total:first.total,first:signature(first),startedAt:now,ids:{},queue:[{filters:{},page:1,level:'root',ids:{}}],minYear,maxYear};save();}
  const s=state.archive.scan;
  for(let count=0;count<maxRequests;count++){
    const task=s.queue[0];
    if(task){
      const p=await get(task.filters,task.page);
      if(p.last_page>20){
        let parts;
        if(task.level==='root')parts=Array.from({length:s.maxYear-s.minYear+1},(_,i)=>s.maxYear-i)
          .filter(year=>year>=2000||year%10===0||year===s.minYear).map(year=>({filters:{year:String(year)},level:'year'}));
        else if(task.level==='year')parts=['movie','tv'].map(type=>({filters:{...task.filters,type},level:'type'}));
        else if(task.level==='type')parts=state.genres.map(g=>({filters:{...task.filters,'genre[]':String(g.id)},level:'genre'}));
        else {s.unresolved ||= [];s.unresolved.push(task.filters);parts=[];}
        s.queue.shift();s.queue.unshift(...parts.map(t=>({...t,page:1,ids:{}})));save();continue;
      }
      if(task.total!==undefined&&task.total!==p.total)throw new Error('Archive changed during partition');
      task.total=p.total;task.first ||= signature(p);
      for(const card of p.data){if(task.ids[card.id])throw new Error('Archive repeated ID across pages');task.ids[card.id]=true;s.ids[card.id]=true;observe(state,card,now);}
      if(task.page===p.last_page){
        if(Object.keys(task.ids).length!==p.total)throw new Error('Incomplete partition');
        const check=await get(task.filters);if(check.total!==p.total||signature(check)!==task.first)throw new Error('Archive changed at partition boundary '+JSON.stringify(task.filters));
        s.queue.shift();
      }else task.page++;
      save();continue;
    }
    // The year filter excludes older/undated titles. Sitemap only proposes
    // candidates: each residual title must be found in the IT archive itself.
    if(Object.keys(s.ids).length<s.total){
      if(!s.candidates){s.candidates=sitemap((await client.get('/titles_it_sitemap.xml')).html);s.candidateIndex=0;save();continue;}
      while(s.candidateIndex<s.candidates.length&&s.ids[s.candidates[s.candidateIndex].id])s.candidateIndex++;
      if(s.candidateIndex===s.candidates.length)throw new Error(`Archive coverage incomplete: ${Object.keys(s.ids).length}/${s.total}; unresolved partitions or sitemap gaps`);
      const candidate=s.candidates[s.candidateIndex];
      if(!s.search){
        let title;
        try{title=detail((await client.get(require('./urls').titlePath(candidate.id,candidate.slug))).html,candidate.id,state.origins);}
        catch(e){if([404,410].includes(e.status)){s.candidateIndex++;save();continue;}throw e;}
        s.search={filters:{search:title.info.name,type:title.info.type},page:1};
      }
      const p=await get(s.search.filters,s.search.page);
      for(const card of p.data){s.ids[card.id]=true;observe(state,card,now);}
      if(s.ids[candidate.id]||s.search.page>=Math.min(p.last_page,20)){s.candidateIndex++;delete s.search;}else s.search.page++;
      save();continue;
    }
    const check=await get({sort:'created_at'});
    if(check.total!==s.total||signature(check)!==s.first||Object.keys(s.ids).length!==s.total)throw new Error('Archive changed or coverage mismatch');
    for(const known of Object.values(state.known))if(known.active&&!s.ids[known.id]&&known.lastSeenAt<s.startedAt)known.missingScans=(known.missingScans||0)+1;
    state.archive={total:s.total,completedAt:now};delete state.errors.archive;save();return;
  }
}
async function scanFeed(client,state,key,{now,save,maxRequests=3}){
  const prior=state.feeds[key]||={};if(!retry(state,'feed:'+key,now)||!prior.scan&&prior.checkedAt&&now-prior.checkedAt<2*HOUR)return;
  for(let n=0;n<maxRequests;n++){
    const s=prior.scan||={page:1,head:null,seen:[]};
    const p=archive((await client.get(archivePath({sort:key},s.page),true)).html,s.page),ids=p.data.map(x=>x.id);
    const fp=signature(p);if(s.seen.includes(fp))throw new Error('Repeated update page');s.seen.push(fp);s.head ||= ids;
    p.data.forEach(card=>observe(state,card,now));
    if(!prior.head?.length||ids.filter(id=>prior.head.includes(id)).length>=Math.min(3,prior.head.length)||s.page===p.last_page){state.feeds[key]={head:s.head,checkedAt:now};delete state.errors['feed:'+key];save();return;}
    if(s.page>=20){state.archive.completedAt=0;state.feeds[key]={head:s.head,checkedAt:now};delete state.errors['feed:'+key];save();return;}
    s.page++;save();
  }
}
async function collect(client,state,root,id,{now,save,maxSeasons=10}){
  const k=state.known[id],draftFile=path.join(root,'drafts',id+'.json');
  let draft=read(draftFile);
  if(!draft||draft.finished||now-draft.startedAt>DAY){const parsed=detail((await client.get(k.path)).html,id,state.origins);
    const {season,...record}=parsed;
    const previous=read(itemFile(root,id)),timestamps=state.records[id]?.seasonCheckedAt||{};
    draft={record,seasons:{},seasonCheckedAt:{},startedAt:now};
    const latest=Math.max(...record.seasonIndex.map(s=>s.number));
    for(const descriptor of record.seasonIndex){
      const oldDescriptor=previous?.seasonIndex?.find(s=>s.id===descriptor.id&&s.number===descriptor.number);
      const saved=previous?.seasons?.find(s=>s.id===descriptor.id&&s.number===descriptor.number);
      const checked=timestamps[descriptor.number];
      if(descriptor.number!==latest&&saved&&oldDescriptor&&Number.isFinite(checked)&&now-checked<30*DAY&&
        (!state.fullSince||checked>=state.fullSince)&&Number.isInteger(descriptor.episodes_count)&&
        saved.episodes?.length===descriptor.episodes_count&&cardFingerprint(oldDescriptor)===cardFingerprint(descriptor)){
        draft.seasons[descriptor.number]=saved;draft.seasonCheckedAt[descriptor.number]=checked;
      }
    }
    if(season){draft.seasons[season.number]=season;draft.seasonCheckedAt[season.number]=now;}
    write(draftFile,draft);}
  const wanted=draft.record.seasonIndex;
  for(const season of wanted.filter(s=>!draft.seasons[s.number]).slice(0,maxSeasons)){
    const parsed=detail((await client.get(draft.record.path+'/season-'+season.number)).html,id,state.origins,season.number);
    if(hash(parsed.seasonIndex)!==hash(wanted)) {write(draftFile,null);throw new Error('Season inventory changed during collection');}
    draft.seasons[season.number]=parsed.season;draft.seasonCheckedAt ||= {};draft.seasonCheckedAt[season.number]=now;write(draftFile,draft);
  }
  if(wanted.some(s=>!draft.seasons[s.number]))return;
  const record={...draft.record,active:true,seasons:wanted.map(s=>draft.seasons[s.number])};
  write(itemFile(root,id),record);draft.finished=true;write(draftFile,draft);
  const stable=record.info.type==='movie'||/ended|canceled|cancelled/i.test(record.info.status||'');
  state.records[id]={complete:true,seasonCheckedAt:draft.seasonCheckedAt||{},checkedAt:now,missingScans:k.missingScans||0,nextCheckAt:now+(stable?30*DAY:DAY)};k.refresh=false;delete state.errors['item:'+id];save();
}
async function run({root=DEFAULT_DATA,client=new Client(),mode='update',stage='all',now=Date.now(),budgetMs=180000,maxRequests=20,maxItems=20,minYear,maxYear}={}){
  if(!['update','full'].includes(mode)||!['all','discover','details','publish'].includes(stage))throw new Error('Invalid run options');
  const state=read(path.join(root,'state.json'))||initialState(),save=()=>write(path.join(root,'state.json'),state);
  if(mode==='full'&&!state.fullSince){state.fullSince=now;state.archive.completedAt=0;}const started=Date.now();
  client.signal ||= AbortSignal.timeout(budgetMs);
  let fatal=null;const retirementHealth={ok:false};
  const attempt=async(key,fn)=>{try{await fn();}catch(e){state.errors[key]={message:String(e.message).slice(0,300),retryAt:now+HOUR,...(Number.isInteger(e.status)?{httpStatus:e.status}:{})};if(key==='archive'&&/changed|repeated|mismatch|coverage incomplete/i.test(e.message))delete state.archive.scan;save();if(client.signal?.aborted||/WARP_REQUIRED/.test(e.message))throw e;}};
  try{
    if(stage!=='publish'){
      const d=await client.discover();state.origins.site=d.baseUrl;state.origins.images=new URL(d.cdn).origin;state.discovery={baseUrl:d.baseUrl,pasteError:d.pasteError};state.genres=d.genres;delete state.errors.discovery;save();
      if(stage==='all'||stage==='discover'){
        await attempt('archive',()=>scanArchive(client,state,{now,save,maxRequests,minYear,maxYear}));
        for(const key of ['created_at','last_air_date'])await attempt('feed:'+key,()=>scanFeed(client,state,key,{now,save}));
      }
      if(stage==='all'||stage==='details')for(const id of Object.keys(state.known).filter(id=>due(state,id,now)).slice(0,maxItems)){
        if(Date.now()-started>=budgetMs-1000)break;
        await attempt('item:'+id,async()=>{
          const k=state.known[id];
          if(k.missingScans&&await require('./retirement').checkRetirement(client,state,root,id,{now,save,health:retirementHealth}))return;
          await collect(client,state,root,id,{now,save});
        });
      }
    }
  }catch(e){fatal=e.message;state.errors.discovery={message:String(e.message).slice(0,300),retryAt:now+HOUR};save();}
  const result=status(state,now,stage);if(result.complete&&!result.hasImmediateWork)delete state.fullSince;
  save();const manifest=publish(root,state,result);console.log('STREAMINGUNITY_BATCH '+JSON.stringify({...result,fatal,expected:manifest.expectedCount,available:manifest.availableCount,archiveTotal:state.archive.scan?.total||state.archive.total||null,archiveKnown:state.archive.scan?Object.keys(state.archive.scan.ids).length:null,errors:Object.keys(state.errors)}));
  return {...result,fatal,state};
}
if(require.main===module)run({mode:process.env.RUN_MODE||'update',stage:process.env.RUN_STAGE||'all'}).then(r=>{if(r.fatal)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run,scanArchive,scanFeed,collect,status,archivePath};
