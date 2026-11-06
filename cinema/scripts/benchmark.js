'use strict';
// Offline publication benchmark; optionally pass a real cinema shard JSON file.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {publish}=require(process.env.BENCH_CATALOG_MODULE||'./catalog');
const {verify}=require('./verify');
const records=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):
  Array.from({length:Number(process.env.BENCH_COUNT||19204)},(_,i)=>({id:`work-${i+1}`,active:true,
    sourceIds:{tmdb:String(i+1)},info:{title:`Title ${i+1}`,type:'movie',year:2020,synopsis:'Plot '.repeat(100)},
    providers:{streamingunity:[{id:i+1,path:`/it/titles/${i+1}-title`,availability:'present',info:{name:`Title ${i+1}`,type:'movie'},seasons:[]}]},
    images:[],seasons:[],warnings:[],enrichment:{status:'pending'}}));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-bench-'));
const registry={nextId:records.length+1,members:Object.fromEntries(records.flatMap(r=>Object.entries(r.providers).flatMap(([p,vs])=>vs.map(v=>[p+':'+v.id,r.id]))))};
const origins={};
function collectOrigins(v){if(!v||typeof v!=='object')return;if(v.base&&v.path)origins[v.base]='https://example.invalid';Object.values(v).forEach(collectOrigins);}
records.forEach(collectOrigins);
const source={snapshots:{streamingunity:{complete:true}},origins,selectedProviders:['streamingunity']};
function measure(label,change){
  const rows=structuredClone(records);if(change)for(const r of rows.slice(0,10))r.info.synopsis=(r.info.synopsis||'')+' updated';
  const counters={reads:0,readBytes:0,writes:0,writeBytes:0},read=fs.readFileSync,write=fs.writeFileSync;
  fs.readFileSync=function(...args){const result=read.apply(this,args);counters.reads++;counters.readBytes+=Buffer.byteLength(result);return result;};
  fs.writeFileSync=function(file,body,...args){counters.writes++;counters.writeBytes+=Buffer.byteLength(body);return write.call(this,file,body,...args);};
  const start=performance.now();
  try{publish(root,rows,source,registry,[],{},{pendingCount:rows.length});}
  finally{fs.readFileSync=read;fs.writeFileSync=write;}
  console.log(JSON.stringify({label,count:rows.length,ms:Math.round(performance.now()-start),...counters}));
  // Integrity verification remains mandatory, outside the publication timing.
  verify(root);
}
try{measure('initial',false);measure('unchanged',false);measure('ten-updated',true);}
finally{fs.rmSync(root,{recursive:true,force:true});}
