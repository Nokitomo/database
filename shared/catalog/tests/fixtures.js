'use strict';
const path=require('node:path');
const {build,load,ids,mediaType}=require('../coverage');
const {write}=require('../../storage/json');
function coverageFor(record,provider,root,now=100){
 const anime=['animeworld','animesaturn','animetop'].includes(provider),kind=anime?'anime':'cinema',primary=anime?'animeunity':'streamingunity';
 const n=Math.max(1,(record.episodes||(record.seasons||[]).flatMap(s=>s.episodes||[])).length);
 const info={title:'Primary title',name:'Primary title',type:mediaType(record)==='movie'?'movie':'TV',synopsis:'Full plot',poster:'poster',background:'background'};
 const canonical={id:'work-1',active:true,sourceIds:ids(record,kind),info,enrichment:{status:'ready'},
  episodes:info.type==='movie'?[]:(record.episodes||(record.seasons||[]).flatMap(s=>(s.episodes||[]).map(e=>({...e,seasonNumber:e.seasonNumber??s.number})))).map((e,i)=>({...e,title:'Chapter '+i,synopsis:'Plot',thumbnail:'image'})),
  providers:{[primary]:[{id:100,availability:'present'}],[provider]:[{id:record.id,path:record.path,info:record.info,availability:'present'}]}};
 const file=path.join(root,'coverage.json');write(file,build([canonical],kind,now));return load(provider,file,now);
}
module.exports={coverageFor};
