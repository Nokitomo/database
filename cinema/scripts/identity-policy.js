'use strict';
const {hash}=require('../../shared/storage/json');
function validate(policy){
  if(!policy||!policy.idCorrections||!Array.isArray(policy.decisions))throw Error('Invalid cinema identity overrides');
  const pairs=new Map();
  for(const rule of policy.decisions){
    if(!['merge','separate'].includes(rule.decision)||!rule.reason||!Array.isArray(rule.sources)||rule.sources.length<2||rule.sources.some(k=>typeof k!=='string'||!k.includes(':'))||new Set(rule.sources).size!==rule.sources.length)throw Error('Invalid cinema review decision');
    for(const a of rule.sources)for(const b of rule.sources)if(a<b){const key=a+'|'+b;if(pairs.has(key)&&pairs.get(key)!==rule.decision)throw Error('Conflicting cinema review decisions');pairs.set(key,rule.decision);}
  }
  return policy;
}
function applyCorrections(entries,policy){
  validate(policy);
  return entries.map(entry=>{
    const rule=policy.idCorrections[entry.key];if(!rule)return entry;
    if(!rule.reason||!rule.ids||Object.keys(rule.ids).some(k=>!['tmdb','imdb','tvdb'].includes(k)))throw Error('Invalid identity correction '+entry.key);
    const out=structuredClone(entry),before={...out.record.sourceIds};
    if(rule.metadata){
      const m=rule.metadata,t=m.tmdb;
      if(m.imdb&&(!/^tt\d+$/.test(m.imdb.id)||m.imdb.id!==rule.ids.imdb||!Array.isArray(m.imdb.seasons)||!m.imdb.seasons.length||m.imdb.seasons.some(n=>!Number.isInteger(n)||n<0)))throw Error('Invalid scoped IMDb target');
      if(m.providerArtworkOnly!==undefined&&typeof m.providerArtworkOnly!=='boolean')throw Error('Invalid artwork policy');
      if(m.sourceOnly&&Object.values(rule.ids).some(v=>v!==null))throw Error('Source-only correction must clear external IDs');
      if(t&&(!['movie','tv'].includes(t.type)||!Number.isSafeInteger(t.id)||t.id<=0||!['work','season-compilation','episode'].includes(t.scope)||t.type==='movie'&&t.scope!=='work'||t.scope!=='work'&&(!Number.isInteger(t.season)||t.season<0)||t.scope==='episode'&&(!Number.isInteger(t.episode)||t.episode<0)))throw Error('Invalid typed TMDB target');
      if(t&&(t.type!==out.record.info.type||t.scope!=='work')&&rule.ids.tmdb!==null)throw Error('Scoped TMDB target must not become a whole-work identity');
      out.record.metadataPolicy=structuredClone(m);
    }
    for(const [key,value]of Object.entries(rule.ids)){
      if(value!==null&&(key==='imdb'?!/^tt\d+$/.test(String(value)):!Number.isSafeInteger(Number(value))||Number(value)<=0))throw Error('Invalid corrected ID '+entry.key);
      const field=key+'_id';out.record.sourceIds[field]=value;out.record.info[field]=value;
    }
    out.record.identityCorrection={originalIds:before,...rule};return out;
  });
}
function decision(policy,a,b){return policy.decisions.find(r=>r.sources.includes(a.key)&&r.sources.includes(b.key))?.decision;}
function mayCombine(entries,policy){
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i],b=entries[j],d=decision(policy,a,b);
    if(d==='separate'||a.provider===b.provider&&d!=='merge')return false;
  }
  return true;
}
function reviews(entries,registry,keysFor,compatible,ids,policy){
  const parent=new Map(entries.map(e=>[e.key,e.key])),lookup=new Map();
  const find=k=>{let r=k;while(parent.get(r)!==r)r=parent.get(r);while(k!==r){const next=parent.get(k);parent.set(k,r);k=next;}return r;};
  for(const e of entries)for(const key of keysFor(e)){
    if(lookup.has(key))parent.set(find(e.key),find(lookup.get(key)));else lookup.set(key,e.key);
  }
  const components=new Map();for(const e of entries){const r=find(e.key);if(!components.has(r))components.set(r,[]);components.get(r).push(e);}
  return [...components.values()].filter(c=>c.length>1).map(c=>{
    c.sort((a,b)=>a.key.localeCompare(b.key));const sources=c.map(e=>e.key);
    const rule=policy.decisions.find(r=>JSON.stringify([...r.sources].sort())===JSON.stringify([...sources].sort()));
    return {id:'identity-'+hash(sources).slice(0,20),reason:c.every(a=>c.every(b=>compatible(a,b)))?'possible-duplicate':'conflicting-external-ids',status:rule?'reviewed':'pending',decision:rule?.decision||null,reviewReason:rule?.reason||null,
      records:c.map(e=>({source:e.key,workId:registry.members[e.key],title:e.record.info.name,type:e.record.info.type,ids:ids(e.record),reference:{base:e.provider+':site',path:e.record.path}}))};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
module.exports={validate,applyCorrections,mayCombine,reviews};
