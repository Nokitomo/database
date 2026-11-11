'use strict';
const {archive,detail}=require('./parse');
const {observe,read,write,itemFile}=require('./store');
const path=require('node:path');
const reviews=require('../retirements.json');
const SIX_HOURS=6*3600000;
const gone=e=>[404,410].includes(e.status);
// Evidence concerns the title endpoint only. A missing season is never a removal.
async function checkRetirement(client,state,root,id,{now,save,health}){
  const k=state.known[id];
  if(!k.missingScans||state.archive.scan||!state.archive.completedAt)return false;
  try{detail((await client.get(k.path)).html,id,state.origins);delete k.notFound;return false;}
  catch(error){if(!gone(error)){delete k.notFound;throw error;}
    const prior=k.notFound;
    k.notFound={path:k.path,firstAt:prior?.path===k.path?prior.firstAt:now,lastAt:now,status:error.status};save();
    const reviewed=reviews.titles[id];
    const manual=reviewed?.path===k.path&&k.lastSeenAt<Date.parse(reviewed.reviewedAt+'T00:00:00Z');
    if(!manual&&k.missingScans<2&&now-k.notFound.firstAt<SIX_HOURS)throw error;
    // A broad outage or a flood of missing titles must not drain the catalog.
    const suspects=Object.values(state.known).filter(v=>v.active&&(v.missingScans>0||v.notFound));
    if(suspects.length>Math.max(5,Math.ceil(Object.values(state.known).filter(v=>v.active).length*0.001)))throw error;
    const record=read(itemFile(root,id));
    if(!record?.info?.name)throw error;
    let found=false;
    for(let page=1;page<=20;page++){
      const query=new URLSearchParams({sort:'created_at',search:record.info.name,type:record.info.type,page:String(page)});
      const result=archive((await client.get('/it/archive?'+query,true)).html,page);
      const card=result.data.find(v=>String(v.id)===String(id));
      if(card){
        observe(state,card,now);
        const draftFile=path.join(root,'drafts',id+'.json'),draft=read(draftFile);
        if(draft&&draft.record?.path!==state.known[id].path)write(draftFile,null);
        save();found=true;break;
      }
      if(page===result.last_page)break;
      if(page===20)throw Error('Retirement search incomplete');
    }
    if(found)return false;
    if(!health.ok){
      const controls=Object.values(state.known).filter(v=>v.active&&!v.missingScans&&!v.notFound&&String(v.id)!==String(id)).slice(0,2);
      if(controls.length!==2)throw Error('Retirement health controls unavailable');
      for(const control of controls)detail((await client.get(control.path)).html,control.id,state.origins);
      health.ok=true;
    }
    k.active=false;k.refresh=false;
    // Retain the published item, but never resume a pre-removal partial draft on reactivation.
    write(path.join(root,'drafts',id+'.json'),null);
    k.retirement={at:now,reason:manual?'reviewed-removal':k.missingScans>=2?'two-archive-omissions':'confirmed-not-found',httpStatus:error.status,archiveCheckedAt:state.archive.completedAt,firstNotFoundAt:k.notFound.firstAt,...(manual?{review:reviewed}: {})};
    delete state.errors['item:'+id];save();return true;
  }
}
module.exports={checkRetirement};
