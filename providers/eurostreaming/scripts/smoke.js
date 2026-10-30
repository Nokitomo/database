'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('./http'),{scanArchive,collect,scanFeed}=require('./pipeline');
const {initialState,publish}=require('./store'),{verify}=require('./verify');
async function smoke(full=process.argv.includes('--archive')){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'eurostreaming-live-')),client=new Client(),s=initialState(),now=Date.now();
 try{
  s.discovery=await client.discover();s.origins.site=s.discovery.baseUrl;
  if(full){do{await scanArchive(client,s,{now,save:()=>{},maxRequests:20});console.log(JSON.stringify({archivePage:s.archive.scan?.page,pages:s.archive.scan?.pages,known:Object.keys(s.known).length}));}while(s.archive.scan);}
  await scanFeed(client,s,{now,save:()=>{}});
  const paths=['/yaga/','/nocturne/','/dark-matter-2024-c/','/matrimonio-a-prima-vista-italia/','/white-collar-2/','/i-griffin-3/','/2-broke-girls-33/'];
  const rows=Object.values(s.known);if(full)for(let i=0;i<12;i++)paths.push(rows[Math.floor(i*(rows.length-1)/11)].path);
  for(const p of new Set(paths)){const r=await collect(client,s,root,p,null,{now,save:()=>{}});console.log(JSON.stringify({path:p,id:r.id,seasons:r.seasons.length,episodes:r.seasons.reduce((n,s)=>n+s.episodes.length,0),warnings:r.warnings}));}
  publish(root,s,{complete:false,pendingCount:Object.keys(s.paths).length});const verified=verify(root);assert(verified.count>=7);
  console.log(JSON.stringify({ok:true,requests:client.requests,archive:s.archive,verified}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)smoke().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={smoke};
