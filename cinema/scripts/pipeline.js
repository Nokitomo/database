'use strict';
const path=require('node:path');
const {read,write,hash}=require('../../shared/storage/json');
const {loadSources,group,mergeGroup,publish}=require('./catalog');
const {enrich:defaultEnrich}=require('./enrich');
async function run({roots,output,providerRoot,enrich=defaultEnrich,stage='all',now=Date.now(),budgetMs=180000,limit=10,identityLookup}){
  if(!['all','merge'].includes(stage))throw Error('Invalid stage');
  const start=Date.now(),source=loadSources(roots);
  const identity=await require('./identity').identify(source,{output,providerRoot,now,deadline:start+budgetMs,limit:stage==='all'?limit:0,lookup:identityLookup});
  const g=group(source.entries,read(path.join(output,'registry.json'))||undefined),state=read(path.join(output,'state.json'),{}),records=[];
  let processed=0,pendingCount=identity.pending,hasImmediateWork=stage==='all'&&identity.immediate;
  for(const group of g.groups){const base=mergeGroup(group),id=group.id;
    const fingerprint=hash({version:1,ids:base.sourceIds,info:base.info,seasons:base.seasons,warnings:base.warnings});
    const file=path.join(output,'enriched',id+'.json'),old=read(file),due=!state[id]||state[id].fingerprint!==fingerprint||state[id].nextCheckAt<=now;
    let enriched=old?.fingerprint===fingerprint?old.record:null;
    if(due&&base.active){pendingCount++;if(stage==='all'&&processed<limit&&Date.now()-start<budgetMs-1000){
      processed++;const draftFile=path.join(output,'drafts',id+'.json'),draft=read(draftFile);
      const resumable=draft?.fingerprint===fingerprint&&now-draft.startedAt<86400000,progress=resumable?draft.progress:{},startedAt=resumable?draft.startedAt:now;
      try{enriched=await enrich(base,{providerRoot,cacheRoot:path.join(output,'cache'),signal:AbortSignal.timeout(Math.max(1,budgetMs-(Date.now()-start))),progress,
        save:progress=>write(draftFile,{fingerprint,startedAt,progress})});
        const retry=enriched.enrichment?.status==='retry';
        const missing=enriched.enrichment?.hasMissingEpisodeMetadata||enriched.enrichment?.status==='unmapped';
        state[id]={fingerprint,nextCheckAt:now+(retry?3600000:(missing?7:30)*86400000)};
        write(file,{fingerprint,record:enriched});write(draftFile,null);if(!retry)pendingCount--;
      }catch(e){state[id]={fingerprint,nextCheckAt:now+3600000,error:String(e.message).slice(0,250)};}
      write(path.join(output,'state.json'),state);
    }else if(stage==='all')hasImmediateWork=true;}
    else if(base.active&&(state[id]?.error||enriched?.enrichment?.status==='retry'||!enriched))pendingCount++;
    // Keep current membership/images even when cached enrichment is reused.
    records.push(enriched?{...base,info:enriched.info,seasons:enriched.seasons,provenance:enriched.provenance,artworkLibrary:enriched.artworkLibrary,externalMedia:enriched.externalMedia,enrichment:enriched.enrichment}:{...base,enrichment:{status:state[id]?.error?'retry':'pending'}});
  }
  const manifest=publish(output,records,source,g.registry,g.conflicts,g.aliases,{pendingCount});
  return {complete:manifest.complete,count:manifest.count,pendingCount,hasImmediateWork,processed};
}
if(require.main===module){const root=path.resolve(__dirname,'../..');run({roots:Object.fromEntries(['streamingunity','altadefinizione','eurostreaming','filmez'].map(p=>[p,path.join(root,'providers',p,'data')])),output:path.join(root,'cinema/data'),providerRoot:path.join(root,'.cache/vega-providers'),stage:process.env.RUN_STAGE||'all'}).then(r=>console.log('CINEMA_BATCH '+JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={run};
