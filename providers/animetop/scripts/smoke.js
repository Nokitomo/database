'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('./http'),{scanArchive,collect}=require('./pipeline'),{detail}=require('./parse');
const {initialState,publish,observe,write,read}=require('./store'),{verify}=require('./verify');
async function smoke(full=process.argv.includes('--archive')){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'animetop-live-')),client=new Client(),s=initialState(),now=Date.now();
 try{
  s.discovery=await client.discover();s.origins.site=s.discovery.baseUrl;
  if(full){do{await scanArchive(client,s,{now,save(){},maxRequests:10});console.log(JSON.stringify({known:Object.keys(s.known).length,cursors:s.archive.scan&&Object.fromEntries(Object.entries(s.archive.scan.kinds).map(([k,v])=>[k,{page:v.page,pages:v.pages,complete:v.complete}]))}));}while(s.archive.scan);}
  const paths=[['/anime-e-cartoni/boruto-naruto-next-generations/','tv_show'],['/anime-e-cartoni/7seeds/','tv_show'],['/anime-e-cartoni/dragon-ball-daima/','tv_show'],['/film-animazione/shaun-vita-da-pecora-operazione-zucca-2026/','movie']];
  for(const [p,kind]of paths){const r=detail((await client.get(p)).html,null,s.origins,p,kind);assert(r.metadataComplete);observe(s,{id:r.id,path:p,kind,name:r.info.title},now);}
  let sampleIds=paths.map(([p])=>Object.values(s.known).find(k=>k.path===p).id);
  if(full)for(const kind of ['tv_show','movie']){const all=Object.values(s.known).filter(k=>k.card.kind===kind);for(let i=0;i<8;i++)sampleIds.push(all[Math.floor(i*(all.length-1)/7)].id);}
  for(const id of new Set(sampleIds)){const r=await collect(client,s,root,id,{now,save(){}});console.log(JSON.stringify({id,title:r.info.title,episodes:r.episodes.length,images:r.images.length,warnings:r.warnings}));}
  publish(root,s,{complete:false});const v=verify(root);assert(v.count>=4);
  // Exercise the real unified loader/publication on real source records, without
  // touching production snapshots or requesting speculative external metadata.
  const auRoot=path.join(root,'empty-au'),awRoot=path.join(root,'empty-aw'),output=path.join(root,'unified');
  write(path.join(auRoot,'raw/index.json'),{expectedIds:[],baseUrl:'https://source.invalid'});
  write(path.join(auRoot,'final/manifest.json'),{complete:true,itemHashes:{}});
  write(path.join(awRoot,'manifest.json'),{complete:true,itemHashes:{},origins:{}});
  await require('../../../unified/scripts/pipeline').run({auRoot,awRoot,output,additionalSources:{animetop:root},stage:'merge'});
  const unified=require('../../../unified/scripts/verify').verify(output),manifest=read(path.join(output,'manifest.json'));
  const records=Object.keys(manifest.itemHashes).map(id=>read(path.join(output,'items',id+'.json')));
  assert.equal(records.reduce((n,r)=>n+r.providers.animetop.length,0),v.count);
  assert(records.some(r=>r.providerImages.animetop.length));
  console.log(JSON.stringify({ok:true,requests:client.requests,archive:s.archive,verified:v,unified}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)smoke().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={smoke};
