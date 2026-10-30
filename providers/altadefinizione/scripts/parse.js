'use strict';
const cheerio=require('cheerio');
const {titlePath,reference}=require('./urls');
function archive(html) {
  const p=JSON.parse(html);
  if(p.ok!==true||!Array.isArray(p.items)||!Number.isSafeInteger(p.count)||p.count<0)throw Error('Invalid archive payload');
  if(new Set(p.items.map(x=>x.id)).size!==p.items.length)throw Error('Duplicate archive IDs');
  for(const x of p.items){titlePath(x.id,x.slug,x.kind);if(!['movie','series'].includes(x.kind)||!x.title)throw Error('Invalid archive card');}
  return p;
}
// Parse data only: never evaluate executable scripts from the site.
function flight(html) {
  const $=cheerio.load(html),chunks=[];
  $('script:not([src])').each((_,e)=>{const m=$(e).text().match(/^self\.__next_f\.push\((.*)\);?$/s);if(m){const a=JSON.parse(m[1]);if(a[0]===1&&typeof a[1]==='string')chunks.push(a[1]);}});
  if(!chunks.length)throw Error('Missing structured detail');return chunks.join('');
}
function jsonAt(s,start) {
  let depth=0,string=false,escape=false;
  for(let i=start;i<s.length;i++) {
    const c=s[i];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;}
    else if(c==='"')string=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){if(--depth===0)return JSON.parse(s.slice(start,i+1));}
  }
  throw Error('Truncated structured detail');
}
function detail(html,id,origins) {
  const s=flight(html),candidates=[...s.matchAll(/"item":\s*(\{)/g)].map(m=>jsonAt(s,m.index+m[0].length-1));
  const item=candidates.find(x=>x.id===Number(id));if(!item||!item.title||!['series','movie'].includes(item.kind))throw Error('Wrong detail identity');
  const texts=new Map();for(const m of s.matchAll(/(?:^|\n)([a-f0-9]+):T([a-f0-9]+),/g))texts.set(m[1],Buffer.from(s.slice(m.index+m[0].length)).subarray(0,parseInt(m[2],16)).toString('utf8'));
  function normalize(v){
    if(typeof v==='string'){
      if(/^\$[a-f0-9]+$/.test(v)){if(!texts.has(v.slice(1)))throw Error('Unresolved detail text');return texts.get(v.slice(1));}
      if(/^https?:\/\//.test(v))return reference(v,origins);
      return v;
    }
    if(Array.isArray(v))return v.map(normalize);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));return v;
  }
  const sm=[...s.matchAll(/"seasons":\s*(\[)/g)];if(sm.length!==1)throw Error('Missing or ambiguous seasons');
  const seasons=jsonAt(s,sm[0].index+sm[0][0].length-1);
  const seen=new Set();for(const season of seasons){
    if(!Number.isInteger(season.number)||season.number<0||seen.has(season.number)||!Array.isArray(season.episodes))throw Error('Invalid season');seen.add(season.number);
    const ep=new Set();for(const e of season.episodes){if(!Number.isFinite(e.number)||e.number<0||ep.has(e.number))throw Error('Invalid episode');ep.add(e.number);}
  }
  const images=[];for(const [field,role]of Object.entries({posterUrl:'poster',logoUrl:'logo',backdropUrl:'background',tileUrl:'tile'}))if(item[field])images.push({role,reference:reference(item[field],origins)});
  for(const [field,role]of Object.entries({posterPaths:'poster',logoPaths:'logo',backdropClean:'background-clean',backdropText:'background-text'}))for(const p of item[field]||[]){
    if(typeof p!=='string'||!p.startsWith('/')||!origins.images)throw Error('Invalid image path');images.push({role,language:null,reference:{base:'images',path:'/t/p/original'+p}});
  }
  // Keep editorial metadata; volatile view counters and administrative flags do not
  // belong in consumer hashes. Episode lists are provider listings, not playback proof.
  const metadata=Object.fromEntries(Object.entries(item).filter(([k])=>!['views','searchBlob','hero','heroOrder','heroPosition','heroScale','heroTrailer','status','legacyUrl'].includes(k)));
  const normalized=normalize(seasons).map(x=>({...x,id:x.number,episodes:x.episodes.map(e=>({...e,id:`${x.number}:${e.number}`,availability:'listed',thumbnail:e.still}))}));
  const count=seasons.reduce((n,x)=>n+x.episodes.length,0),warnings=[];
  if(item.numberOfEpisodes!=null&&item.numberOfEpisodes!==count)warnings.push('declared-episode-count-mismatch');
  if(item.numberOfSeasons!=null&&item.numberOfSeasons!==seasons.length)warnings.push('declared-season-count-mismatch');
  return {id:Number(id),provider:'altadefinizione',locale:'it',path:titlePath(id,item.slug,item.kind),active:true,
    sourceIds:{tmdb_id:item.tmdbId||null,imdb_id:item.imdbId||null,tvdb_id:item.tvdbId||null,wikidata_id:item.wikidataId||null},
    info:{...normalize(metadata),name:item.title,type:item.kind==='series'?'tv':'movie',status:item.releaseStatus},images,
    seasonIndex:normalized.map(x=>({id:x.id,number:x.number,episodes_count:x.episodes.length})),seasons:normalized,warnings};
}
module.exports={archive,detail,flight,jsonAt};
