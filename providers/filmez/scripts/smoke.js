'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('./http'),{scanArchive,collect}=require('./pipeline'),{apiArchive}=require('./parse');
const {initialState,observe,publish}=require('./store'),{verify}=require('./verify');
async function smoke(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'filmez-live-')),client=new Client(),s=initialState(),now=Date.now();
 try{
  s.discovery=await client.discover();s.origins.site=client.baseUrl;
  if(process.argv.includes('--archive')){
   do{await scanArchive(client,s,{now,save(){},maxRequests:20});console.log(JSON.stringify({known:Object.keys(s.known).length,cursor:s.archive.scan?.kinds.movie?.page}));}while(s.archive.scan);
  }else{
   const fetch=async page=>apiArchive(await client.get('/wp-json/wp/v2/movie?per_page=100&page='+page+'&orderby=id&order=asc'),client.baseUrl,'movie',page);
   const first=await fetch(1),pages=new Map([[1,first]]);
   for(let i=0;i<10;i++){const position=Math.floor(i*(first.total-1)/9),page=Math.floor(position/100)+1;if(!pages.has(page))pages.set(page,await fetch(page));observe(s,pages.get(page).items[position%100],now);}
  }
  const all=Object.values(s.known);
  for(let i=0;i<10;i++){
   const k=all[Math.floor(i*(all.length-1)/9)],r=await collect(client,s,root,k.id,{now,save(){}});
   assert(r.info.synopsis);assert(r.info.year);assert(r.info.poster||r.sourceMetadata.featuredMediaStatus==='missing'||!r.sourceMetadata.featuredMediaId);
   console.log(JSON.stringify({id:r.id,title:r.info.title,images:r.images.length,links:r.playback.length,ids:r.sourceIds,alias:r.sourceAlias,warnings:r.warnings}));
  }
  publish(root,s,{complete:false});console.log(JSON.stringify({verified:verify(root),archive:s.archive,requests:client.requests}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)smoke().catch(e=>{console.error(e);process.exitCode=1});module.exports={smoke};
