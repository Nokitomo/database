'use strict';
const {execFileSync}=require('node:child_process');
const {selectProviders,sourceFingerprint}=require('./catalog');

const activeStatuses=new Set(['queued','in_progress','pending','requested','waiting']);
function decision(runs,cinema,sources){
  if(runs.some(run=>activeStatuses.has(run.status)))return 'busy';
  if(!cinema)return 'missing_database';
  if(cinema.pendingCount>0)return 'pending_enrichment';
  const selected=selectProviders(cinema.selectedProviders||['streamingunity']);
  if(selected.some(provider=>sources[provider]&&(
    sourceFingerprint(sources[provider])!==cinema.sources?.[provider]?.contentHash||
    sources[provider].complete!==cinema.sources?.[provider]?.complete)))return 'source_changed';
  return 'up_to_date';
}
function gh(...args){return execFileSync('gh',args,{encoding:'utf8',maxBuffer:64*1024*1024});}
function manifest(repo,provider){
  const file=provider?`providers/${provider}/data/manifest.json`:'cinema/data/manifest.json';
  const ref=provider?`${provider}-data`:'cinema-data';
  try{return JSON.parse(gh('api','-H','Accept: application/vnd.github.raw',`repos/${repo}/contents/${file}?ref=${ref}`));}
  catch(error){if(/HTTP 404/.test(String(error.stderr)))return null;throw error;}
}
function main(){
  const repo=process.env.GH_REPO;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||''))throw Error('GH_REPO is required');
  const runs=JSON.parse(gh('run','list','--repo',repo,'--workflow','update-cinema.yml','--limit','50','--json','status'));
  if(runs.some(run=>activeStatuses.has(run.status))){console.log('CINEMA_SCHEDULE_SKIP busy');return;}
  const cinema=manifest(repo);
  const selected=selectProviders(cinema?.selectedProviders||['streamingunity']);
  const sources=Object.fromEntries(selected.map(provider=>[provider,manifest(repo,provider)]));
  const reason=decision(runs,cinema,sources);
  if(reason==='busy'||reason==='up_to_date'){console.log('CINEMA_SCHEDULE_SKIP '+reason);return;}
  gh('workflow','run','update-cinema.yml','--repo',repo,'--ref','main','-f','stage=all','-f',`sources=${selected.join(',')}`);
  console.log('CINEMA_SCHEDULE_DISPATCH '+reason+' sources='+selected.join(','));
}
if(require.main===module)try{main();}catch(error){console.error(error);process.exitCode=1;}
module.exports={decision,activeStatuses};
