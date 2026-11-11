'use strict';
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const episodeOverrides=require('../episode-overrides.json');
const {read,write,hash}=require('../../shared/storage/json');
const {loadSources,group,mergeGroup,publish}=require('./catalog');
const {enrich:defaultEnrich}=require('./enrich');
const {mediaFields}=require('./tmdb-adapter');
const metrics=require('../../shared/metrics');
const inputs=require('./enrichment-input');
const run=options=>metrics.capture(()=>runBatch(options));
async function runBatch({roots,output,providerRoot,enrich=defaultEnrich,stage='all',now=Date.now(),budgetMs=180000,limit=100,identityLookup,selectedProviders}){
  if(!['all','merge'].includes(stage))throw Error('Invalid stage');
  if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(budgetMs)||budgetMs<0||
    (stage==='all'&&(limit===0||budgetMs<=1000)))throw Error('Invalid cinema batch limits: all requires limit >= 1 and budgetMs > 1000 (integer values)');
  const start=Date.now(),timings={},clock=()=>performance.now();let mark=clock();
  const elapsed=key=>{const end=clock();timings[key]=(timings[key]||0)+end-mark;mark=end;};
  const source=loadSources(roots,selectedProviders);elapsed('sourcesMs');
  const priorManifest=read(path.join(output,"manifest.json"));
  if(priorManifest&&JSON.stringify([...(priorManifest.selectedProviders||Object.keys(priorManifest.sources))].sort())!==JSON.stringify([...source.selectedProviders].sort()))throw Error("Cinema source selection differs from published database; use a separate output for a different selection");
  const policy=require('../identity-overrides.json');source.entries=require('./identity-policy').applyCorrections(source.entries,policy);
  const identity=await require('./identity').identify(source,{output,providerRoot,now,deadline:start+budgetMs,limit:stage==='all'?limit:0,lookup:identityLookup});
  elapsed('identityMs');
  const g=group(source.entries,read(path.join(output,'registry.json'))||undefined,policy),state=read(path.join(output,'state.json'),{}),records=[];
  elapsed('groupingMs');
  let processed=0,pendingCount=identity.pending,hasImmediateWork=stage==='all'&&identity.immediate;
  for(const group of g.groups){let phaseStart=clock();const base=require('./metadata-corrections').applyMetadataCorrections(mergeGroup(group)),id=group.id;
    timings.mergeMs=(timings.mergeMs||0)+clock()-phaseStart;phaseStart=clock();
    const rawInput=inputs.input(base,group.entries,episodeOverrides),fingerprint=hash(inputs.semantic(rawInput));
    timings.fingerprintMs=(timings.fingerprintMs||0)+clock()-phaseStart;phaseStart=clock();
    const file=path.join(output,'enriched',id+'.json'),old=read(file);
    const legacyHashes=new Set([hash(rawInput)]);
    if(old&&old.fingerprintVersion!==3){
      const prior=old.fingerprint===hash(rawInput)?rawInput:inputs.legacyInput(old,group,episodeOverrides);
      if(prior&&hash(inputs.semantic(prior))===fingerprint){
        legacyHashes.add(old.fingerprint);
        old.fingerprint=fingerprint;old.fingerprintVersion=3;write(file,old);
        if(state[id]&&legacyHashes.has(state[id].fingerprint))state[id].fingerprint=fingerprint;
        const draftFile=path.join(output,'drafts',id+'.json'),draft=read(draftFile);
        if(draft&&legacyHashes.has(draft.fingerprint))write(draftFile,{...draft,fingerprint});
      }
    }
    const due=!state[id]||state[id].fingerprint!==fingerprint||state[id].nextCheckAt<=now;
    timings.enrichedReadMs=(timings.enrichedReadMs||0)+clock()-phaseStart;
    let enriched=old?.fingerprint===fingerprint?old.record:null;
    if(enriched){
      const cached=mediaFields(enriched.externalMedia?.tmdb);let repaired=false;
      for(const field of ['year','runtime'])if((enriched.info[field]==null||enriched.info[field]==='')&&cached[field]!=null){enriched.info[field]=cached[field];repaired=true;}
      if(repaired)write(file,{fingerprint,fingerprintVersion:3,record:enriched});
    }
    if(due&&base.active){pendingCount++;if(stage==='all'&&processed<limit&&Date.now()-start<budgetMs-1000){
      processed++;const draftFile=path.join(output,'drafts',id+'.json'),draft=read(draftFile);
      const resumable=(draft?.fingerprint===fingerprint||legacyHashes.has(draft?.fingerprint))&&now-draft.startedAt<30*86400000,progress=resumable?draft.progress:{},startedAt=resumable?draft.startedAt:now;
      const externalStart=clock();
      try{enriched=await enrich(base,{providerRoot,cacheRoot:path.join(output,'cache'),signal:AbortSignal.timeout(Math.max(1,budgetMs-(Date.now()-start))),progress,previous:enriched,now,
        save:progress=>write(draftFile,{fingerprint,startedAt,progress})});
        const retry=enriched.enrichment?.status==='retry';
        const missing=enriched.enrichment?.hasMissingEpisodeMetadata||enriched.enrichment?.status==='unmapped';
        state[id]={fingerprint,nextCheckAt:retry&&Number.isFinite(enriched.enrichment?.nextCheckAt)?Math.max(now+1000,enriched.enrichment.nextCheckAt):now+(retry?3600000:(missing?7:30)*86400000)};
        write(file,{fingerprint,fingerprintVersion:3,record:enriched});if(!retry){write(draftFile,null);pendingCount--;}
      }catch(e){state[id]={fingerprint,nextCheckAt:now+3600000,error:String(e.message).slice(0,250)};}
      timings.enrichmentMs=(timings.enrichmentMs||0)+clock()-externalStart;
      const checkpointStart=clock();write(path.join(output,'state.json'),state);
      timings.stateCheckpointMs=(timings.stateCheckpointMs||0)+clock()-checkpointStart;
    }else if(stage==='all')hasImmediateWork=true;}
    else if(base.active&&(state[id]?.error||enriched?.enrichment?.status==='retry'||!enriched))pendingCount++;
    // Keep current membership/images even when cached enrichment is reused.
    records.push(enriched?{...base,sourceIds:{...base.sourceIds,...enriched.sourceIds},externalIdsEvidence:enriched.externalIdsEvidence,warnings:[...base.warnings,...(enriched.warnings||[]).filter(w=>!base.warnings.some(b=>hash(b)===hash(w)))],info:inputs.refreshInfo(enriched.info,base.info),seasons:enriched.seasons,provenance:enriched.provenance,artworkLibrary:enriched.artworkLibrary,externalMedia:enriched.externalMedia,enrichment:enriched.enrichment}:{...base,enrichment:{status:state[id]?.error?'retry':'pending'}});
  }
  elapsed('assemblyMs');
  write(path.join(output,'state.json'),state);
  const manifest=publish(output,records,source,g.registry,g.conflicts,g.aliases,{pendingCount},g.review,g.splits);
  elapsed('publicationMs');
  // assemblyMs includes enrich calls; separate their measured wall time for attribution.
  timings.assemblyMs=Math.max(0,timings.assemblyMs-(timings.enrichmentMs||0)-(timings.stateCheckpointMs||0));
  timings.totalMs=Date.now()-start;
  return {complete:manifest.complete,count:manifest.count,pendingCount,hasImmediateWork,processed,identityProcessed:identity.processed,timings};
}
if(require.main===module){const root=path.resolve(__dirname,'../..');run({roots:Object.fromEntries(['streamingunity','altadefinizione','eurostreaming','filmez'].map(p=>[p,path.join(root,'providers',p,'data')])),output:path.join(root,'cinema/data'),providerRoot:path.join(root,'.cache/vega-providers'),selectedProviders:process.env.CINEMA_SOURCES||undefined,stage:process.env.RUN_STAGE||'all',limit:Number(process.env.CINEMA_BATCH_LIMIT||100),budgetMs:Number(process.env.CINEMA_BUDGET_MS||180000)}).then(r=>console.log('CINEMA_BATCH '+JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={run};
