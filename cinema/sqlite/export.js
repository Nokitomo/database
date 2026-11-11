'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {read}=require('../../shared/storage/json');
const {normalize}=require('./normalize');
function verifyImageCoverage(record,origins,rows){
  const indexed=new Set(rows.filter(r=>r.kind==='artwork').map(r=>r.payload.url));
  const check=value=>{
    if(typeof value==='string'&&/^https?:\/\//.test(value)&&(/\.(?:jpg|jpeg|png|webp|svg|gif|avif)(?:[?#]|$)/i.test(value)||/\/(?:images|banners|t\/p)\//.test(value))&&!indexed.has(new URL(value).href))throw Error('Unindexed image reference in '+record.id);
  };
  function walk(value){
    if(typeof value==='string'){check(value);return;}
    if(!value||typeof value!=='object')return;
    if(value.base&&value.path&&origins[value.base])check(new URL(value.path,origins[value.base]).href);
    Object.values(value).forEach(walk);
  }
  walk(record);
}
function exportRows(root,out,{allowIncomplete=false}={}){
  const m=read(path.join(root,'manifest.json'));
  if(!allowIncomplete&&(m?.complete!==true||m.pendingCount!==0||!Object.keys(m.sources||{}).length||Object.values(m.sources||{}).some(v=>v.complete!==true)))throw Error('Cinema snapshot is incomplete; publication blocked');
  fs.mkdirSync(out,{recursive:true});const rows=path.join(out,'rows.ndjson'),fd=fs.openSync(rows,'w');
  let count=0;
  try{require('../scripts/verify').verify(root,{onRecord(record){
    if(!allowIncomplete&&(Object.values(record.providers||{}).flat().some(v=>v.availability==='unknown')||record.active&&['retry','pending'].includes(record.enrichment?.status)))throw Error('Unresolved Cinema record');
    const normalized=normalize(record,m.origins);verifyImageCoverage(record,m.origins,normalized);
    fs.writeSync(fd,normalized.map(row=>JSON.stringify(row)+'\n').join(''));
    if(++count%1000===0)console.log('CINEMA_SQLITE_ROWS works='+count);
  }});}finally{fs.closeSync(fd);}
  return m;
}
if(require.main===module){
  const [root,out,sourceCommit,exporterCommit,previous]=process.argv.slice(2);
  if(!root||!out||!/^([a-f0-9]{40})$/.test(sourceCommit||'')||!/^([a-f0-9]{40})$/.test(exporterCommit||''))throw Error('Usage: export.js INPUT OUTPUT SOURCE_SHA EXPORTER_SHA [PREVIOUS_SQLITE]');
  const m=exportRows(root,out,{allowIncomplete:process.env.CINEMA_SQLITE_VALIDATION_ONLY==='1'});
  fs.writeFileSync(path.join(out,'input.json'),JSON.stringify({sourceCommit,exporterCommit,complete:m.complete===true&&process.env.CINEMA_SQLITE_VALIDATION_ONLY!=='1',origins:m.origins,expectedCount:m.count,expectedActiveCount:m.activeCount}));
  if(process.env.CINEMA_SQLITE_ROWS_ONLY!=='1'){
    const result=spawnSync(process.env.PYTHON||'python',['-B',path.join(__dirname,'database.py'),'build',out,...(previous?[previous]:[])],{stdio:'inherit'});process.exitCode=result.status??1;
  }
}
module.exports={exportRows,verifyImageCoverage};
