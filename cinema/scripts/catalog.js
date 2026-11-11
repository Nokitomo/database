'use strict';
const path=require('node:path');
const {read,write,hash}=require('../../shared/storage/json');
const PROVIDERS=['streamingunity','altadefinizione','eurostreaming','filmez'];
const sourceFingerprint=manifest=>hash({itemHashes:manifest.itemHashes,origins:manifest.origins,expectedCount:manifest.expectedCount});
function selectProviders(value=PROVIDERS){
  const selected=Array.isArray(value)?value:String(value).split(",").map(v=>v.trim());
  if(!selected.length||new Set(selected).size!==selected.length||selected.some(p=>!PROVIDERS.includes(p)))throw Error("Invalid cinema sources");
  return selected;
}
function loadSources(roots,selected=PROVIDERS){
  selected=selectProviders(selected);
  const entries=[],snapshots={},origins={},missingProviders=[];
  for(const provider of selected){
    if(['eurostreaming','filmez'].includes(provider)&&(!roots[provider]||!require('node:fs').existsSync(path.join(roots[provider],'manifest.json')))){missingProviders.push(provider);continue;}
    require(`../../providers/${provider}/scripts/verify`).verify(roots[provider],{onRecord:r=>entries.push({key:provider+':'+r.id,provider,record:r})});
    const m=read(path.join(roots[provider],'manifest.json'));snapshots[provider]={hash:hash(m),contentHash:sourceFingerprint(m),complete:m.complete,expectedCount:m.expectedCount};
    for(const [key,value]of Object.entries(m.origins))origins[provider+':'+key]=value;
  }
  return {entries,snapshots,origins,missingProviders,selectedProviders:selected};
}
function ids(record){const s=record.sourceIds||{};return {tmdb:positive(s.tmdb_id),imdb:/^tt\d+$/.test(s.imdb_id||'')?s.imdb_id:null,tvdb:positive(s.tvdb_id)};}
function positive(v){return Number.isSafeInteger(Number(v))&&Number(v)>0?String(v):null;}
function compatible(a,b){if(a.record.info.type!==b.record.info.type)return false;const x=ids(a.record),y=ids(b.record);return !Object.keys(x).some(k=>x[k]&&y[k]&&x[k]!==y[k]);}
function group(entries,registry={nextId:1,members:{}},policy=require('../identity-overrides.json')){
  const identityPolicy=require('./identity-policy');identityPolicy.validate(policy);
  const originalMembers={...registry.members};
  const bySource=new Map(entries.map(e=>[e.key,e]));
  for(const rule of policy.decisions.filter(r=>r.decision==='merge')){const present=rule.sources.map(k=>bySource.get(k)).filter(Boolean);if(present.some(a=>present.some(b=>!compatible(a,b))))throw Error('Correct conflicting external IDs before approving a merge');}
  const keysFor=e=>{const keys=Object.entries(ids(e.record)).filter(([,v])=>v).map(([k,v])=>`${e.record.info.type}:${k}:${v}${k==='imdb'&&e.record.metadataPolicy?.imdb?':seasons:'+e.record.metadataPolicy.imdb.seasons.join(','):''}`);
    if(e.provider==='filmez'){const alias=e.record.sourceAlias;const canonical=alias?.method==='identical-provider-url-title-and-full-plot'?positive(alias.canonicalId):null;keys.push(e.record.info.type+':filmez-source:'+(canonical||e.record.id));}
    policy.decisions.forEach((r,i)=>{if(r.decision==='merge'&&r.sources.includes(e.key))keys.push('manual:'+i);});return keys;};
  registry=structuredClone(registry);const groups=[],lookup=new Map(),conflicts=[];
  for(const e of [...entries].sort((a,b)=>a.key.localeCompare(b.key))){
    const keys=keysFor(e);
    const candidates=[...new Set(keys.flatMap(k=>lookup.get(k)||[]))];
    let g;
    if(candidates.length&&identityPolicy.mayCombine([e,...candidates.flatMap(c=>c.entries)],policy)&&candidates.every(c=>c.entries.every(other=>compatible(e,other)))&&candidates.every(c=>candidates.every(d=>c.entries.every(x=>d.entries.every(y=>compatible(x,y)))))){
      g=candidates[0];for(const other of candidates.slice(1)){g.entries.push(...other.entries);groups.splice(groups.indexOf(other),1);for(const [k,list]of lookup)lookup.set(k,[...new Set(list.map(v=>v===other?g:v))]);}
    }else{if(candidates.length&&candidates.some(c=>c.entries.some(other=>!compatible(e,other))))conflicts.push({source:e.key,reason:'conflicting-external-ids',blocking:false,candidates:candidates.flatMap(c=>c.entries.map(x=>x.key))});g={entries:[]};groups.push(g);}
    g.entries.push(e);for(const k of keys)lookup.set(k,[...new Set([...(lookup.get(k)||[]),g])]);
  }
  const used=new Set(),aliases={};
  for(const g of groups){const prior=[...new Set(g.entries.map(e=>registry.members[e.key]).filter(Boolean))].sort((a,b)=>Number(a.split('-')[1])-Number(b.split('-')[1]));
    const compositions=policy.decisions.filter(r=>r.catalog&&r.sources.some(k=>g.entries.some(e=>e.key===k)));
    if(compositions.length>1)throw Error('Conflicting catalog compositions');
    if(compositions.length){g.catalogPolicy=structuredClone(compositions[0].catalog);if(g.catalogPolicy.kind==='seasons'&&g.entries.some(e=>ids(e.record).tmdb!==String(g.catalogPolicy.tmdbId)))throw Error('Composition TMDB identity changed');}
    g.id=prior.find(id=>!used.has(id))||`work-${registry.nextId++}`;used.add(g.id);
    for(const old of prior)if(old!==g.id&&!used.has(old))aliases[old]=g.id;
    for(const e of g.entries)registry.members[e.key]=g.id;
  }
  const previous=new Map();for(const [key,id]of Object.entries(originalMembers)){if(!previous.has(id))previous.set(id,[]);previous.get(id).push(key);}
  const splits=[...previous].filter(([,keys])=>new Set(keys.map(k=>registry.members[k])).size>1).map(([workId,keys])=>({workId,members:Object.fromEntries(keys.map(k=>[k,registry.members[k]]))}));
  const review=identityPolicy.reviews(entries,registry,keysFor,compatible,ids,policy);
  return {groups,registry,conflicts,aliases,review,splits};
}
function namespace(v,p){if(Array.isArray(v))return v.map(x=>namespace(x,p));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='base'&&typeof x==='string'&&!x.includes(':')?p+':'+x:namespace(x,p)]));return v;}
const meaningful=v=>typeof v==='string'&&v.trim()&&!/^(?:episode|episodio)\s*[\d.]+$/i.test(v.trim());
function episodeData(e){return {title:e.name||e.title||null,synopsis:e.plot||e.synopsis||null,thumbnail:e.thumbnail||e.still||e.images?.find(x=>/still|thumbnail/i.test(x.type||''))?.reference||e.images?.[0]?.reference||null};}
function mergeGroup(g){
  const composition=g.catalogPolicy;
  const ordered=[...g.entries].sort((a,b)=>(Number(b.key===composition?.primary)-Number(a.key===composition?.primary))||PROVIDERS.indexOf(a.provider)-PROVIDERS.indexOf(b.provider)||Number(a.record.id)-Number(b.record.id));
  const primary=ordered[0],r=primary.record,external={tmdb:null,imdb:null,tvdb:null},providers={},images=[],seasons=new Map(),warnings=[];
  const info={...namespace(r.info,primary.provider),title:r.info.name,type:r.info.type,year:r.info.year||Number(String(r.info.release_date||'').slice(0,4))||null,synopsis:r.info.plot||r.info.synopsis||null};const provenance={};
  for(const entry of ordered){const record=namespace(entry.record,entry.provider);for(const [k,v]of Object.entries(ids(entry.record)))if(v)external[k]=v;
    warnings.push(...(record.warnings||[]).map(reason=>({source:entry.key,reason})));
    (providers[entry.provider]||=[]).push({id:record.id,path:record.path,availability:record.active?'present':'unavailable',...(composition?{preferred:entry.key===composition.primary,timelineCompatibility:composition.timelineCompatibility||'not-applicable',...(composition.observations?.[entry.key]?{streamObservation:composition.observations[entry.key]}:{})}:{}),seasons:record.seasons,info:record.info,...(record.episodeBlocks?{episodeBlocks:record.episodeBlocks}:{}),...(record.sourceAlias?{sourceAlias:record.sourceAlias}:{}),...(record.sourceMetadata?{sourceMetadata:record.sourceMetadata}:{}),...(record.playback?{playback:record.playback}:{}),...(record.identity?{identity:record.identity}:{}),...(record.identityCorrection?{identityCorrection:record.identityCorrection}:{})});
    images.push(...record.images.map(x=>({...x,provider:entry.provider})));if(!info.synopsis&&(record.info.plot||record.info.synopsis))info.synopsis=record.info.plot||record.info.synopsis;
    for(const [key,value]of Object.entries(record.info))if((info[key]==null||info[key]===''||Array.isArray(info[key])&&!info[key].length)&&value!=null)info[key]=value;
    for(const field of ['poster','background','logo'])if(!info[field])info[field]=record.images.find(x=>(x.role||x.type)===field)?.reference;
    for(const sourceSeason of record.seasons){
      const mapped=composition?.kind==='seasons'?composition.seasonMaps[entry.key]?.[sourceSeason.number]:sourceSeason.number;
      if(mapped===undefined){warnings.push({source:entry.key,season:sourceSeason.number,reason:'unmapped-provider-season'});continue;}
      const s={...sourceSeason,number:mapped};let season=seasons.get(s.number);
      if(season&&hash(season.episodes.map(e=>String(e.number)).sort())!==hash(s.episodes.map(e=>String(e.number)).sort())){
        warnings.push({source:entry.key,season:s.number,reason:'provider-episode-inventory-conflict'});continue;
      }
      if(!season){season={number:s.number,episodes:[],images:s.images||[]};seasons.set(s.number,season);}
      for(const ep of s.episodes){let e=season.episodes.find(x=>String(x.number)===String(ep.number));const data=episodeData(ep);
        if(entry.provider==='eurostreaming'&&primary!==entry&&(!e||!meaningful(e.title)||!meaningful(data.title)||e.title.toLowerCase()!==data.title.toLowerCase()))continue;
        if(!e){e={number:ep.number,...data,metadataSources:{}};season.episodes.push(e);}
        if(composition){e.playbackSources||=[];e.playbackSources.push({provider:entry.provider,titleId:record.id,path:record.path,season:sourceSeason.number,seasonId:sourceSeason.id??null,episode:ep.number,episodeId:ep.id??null,availability:record.active?'present':'unavailable'});}
        e.metadataSources[entry.key]=data;
        if(meaningful(e.title)&&meaningful(data.title)&&e.title.toLowerCase()!==data.title.toLowerCase()){warnings.push({season:s.number,episode:ep.number,source:entry.key,reason:'episode-title-conflict'});continue;}
        for(const k of ['title','synopsis','thumbnail'])if((k==='title'?!meaningful(e[k]):!e[k])&&data[k]){e[k]=data[k];provenance[`${s.number}:${ep.number}:${k}`]=entry.key;}
      }
    }
  }
  if(composition?.kind==='seasons'){
    // Work-level metadata must describe the container, never one of its component series.
    for(const key of Object.keys(info))delete info[key];
    Object.assign(info,{name:composition.title,title:composition.title,type:'tv',tmdb_id:composition.tmdbId,imdb_id:external.imdb});
    for(const season of seasons.values())Object.assign(season,composition.seasonMetadata[season.number],{externalMappings:{tmdb:{id:composition.tmdbId,season:season.number,status:'verified',method:'verified-override'}}});
    require('./composition').labelSeasons([...seasons.values()]);
  }
  const active=ordered.some(x=>x.record.active);
  return {id:g.id,active,sourceIds:external,info,providers,images,...((r.metadataPolicy||composition)?{metadataPolicy:{...r.metadataPolicy,...(composition?{catalog:composition}:{})}}:{}),
    episodeMappingUncertain:!!r.episodeMappingUncertain||(r.warnings||[]).some(w=>/count-mismatch/.test(w)),
    seasons:[...seasons.values()].sort((a,b)=>a.number-b.number).map(s=>({...s,episodes:s.episodes.sort((a,b)=>Number(a.number)-Number(b.number))})),provenance,warnings};
}
function publish(root,records,source,registry,conflicts,aliases,status,review=[],splits=[]){
  const old=read(path.join(root,'manifest.json'),{itemHashes:{},origins:{}}),byId=new Map(records.map(r=>[r.id,r]));
  for(const [id,expected]of Object.entries(old.itemHashes)){
    const prior=read(path.join(root,'items',id+'.json'));if(!prior||hash(prior)!==expected)throw Error('Corrupt retained record '+id);
    const current=byId.get(id);
    if(current){
      for(const [provider,variants]of Object.entries(prior.providers))for(const variant of variants){
        if(!(current.providers[provider]||[]).some(v=>String(v.id)===String(variant.id))){
          const reassigned=registry.members[provider+':'+variant.id]&&registry.members[provider+':'+variant.id]!==id;
          if(!reassigned)(current.providers[provider]||=[]).push({...variant,availability:variant.availability==='unavailable'?'unavailable':'unknown'});
        }
      }
      current.active=Object.values(current.providers).flat().some(v=>['present','unknown'].includes(v.availability));
    }
    if(!byId.has(id)){if(aliases[id]){prior.active=false;prior.replacedBy=aliases[id];for(const vs of Object.values(prior.providers))vs.forEach(v=>v.availability='reassigned');}
      else{for(const vs of Object.values(prior.providers))vs.forEach(v=>{if(v.availability==='present')v.availability='unknown';});}
      byId.set(id,prior);
    }
  }
  const all=[...byId.values()].sort((a,b)=>a.id.localeCompare(b.id)),itemHashes={},shards=Array.from({length:100},()=>[]),shardHashes={};
  const changed=[],dirtyShards=new Set();
  for(const r of all){
    itemHashes[r.id]=hash(r);const shard=Number(r.id.split('-')[1])%100;
    if(itemHashes[r.id]!==old.itemHashes[r.id]){
      changed.push(r.id);dirtyShards.add(shard);write(path.join(root,'items',r.id+'.json'),r);
    }
    shards[shard].push(r);
  }
  // Retained items were verified above. The runner still verifies every shard before push.
  shards.forEach((v,i)=>{const key=String(i).padStart(2,'0'),file=path.join(root,'shards',key+'.json');
    if(!dirtyShards.has(i)&&old.shardHashes?.[key]&&require('node:fs').existsSync(file))shardHashes[key]=old.shardHashes[key];
    else{write(file,v);shardHashes[key]=hash(v);}
  });
  const catalog=all.filter(r=>r.active).map(r=>({id:r.id,title:r.info.title,type:r.info.type,year:r.info.year,poster:r.info.poster,background:r.info.background,logo:r.info.logo,sourceIds:r.sourceIds}));write(path.join(root,'catalog.json'),catalog);write(path.join(root,'registry.json'),registry);
  const unknown=all.some(r=>Object.values(r.providers).flat().some(v=>v.availability==='unknown'));
  const identityIssues=all.flatMap(r=>Object.entries(r.providers).flatMap(([provider,variants])=>variants.filter(v=>v.identity&&v.identity.status!=='verified').map(v=>({workId:r.id,provider,id:v.id,...v.identity}))));
  const reviewBody={schemaVersion:1,issues:review};write(path.join(root,'identity-review.json'),reviewBody);
  if(splits.length){const migration=read(path.join(root,'identity-migration.json'),{schemaVersion:1,splits:[]});for(const split of splits)if(!migration.splits.some(s=>hash(s)===hash(split)))migration.splits.push(split);write(path.join(root,'identity-migration.json'),migration);}
  const m={schemaVersion:1,kind:'cinema',identityPolicyVersion:2,reviewHash:hash(reviewBody),pendingReviewCount:review.filter(r=>r.status==='pending').length,selectedProviders:source.selectedProviders||Object.keys(source.snapshots),count:all.length,activeCount:catalog.length,itemHashes,shardHashes,catalogHash:hash(catalog),origins:{...old.origins,...source.origins},sources:source.snapshots,awaitingProviders:source.missingProviders||[],identityIssues,conflicts,aliases,...status};
  m.complete=Object.values(source.snapshots).every(s=>s.complete)&&!unknown&&!m.pendingCount;
  write(path.join(root,'changes.json'),{changed,removed:[]});
  // Keep coverage fresh for consumers (7-day expiry), without timestamp-only churn per batch.
  const coverageModule=require('../../shared/catalog/coverage'),coverage=read(path.join(root,'coverage.json'));
  if(!changed.length&&coverage&&old.coverageHash&&Date.now()>=coverage.generatedAt&&Date.now()-coverage.generatedAt<86400000){
    coverageModule.verifyPublication(root,old.coverageHash,'cinema');m.coverageHash=old.coverageHash;
  }else m.coverageHash=coverageModule.publish(root,all,'cinema');
  write(path.join(root,'manifest.json'),m);return m;
}
module.exports={selectProviders,sourceFingerprint,loadSources,ids,compatible,group,mergeGroup,publish,namespace,meaningful};

