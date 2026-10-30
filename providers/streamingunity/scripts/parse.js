'use strict';
const cheerio=require('cheerio');
const {titlePath,reference}=require('./urls');
function payload(html){
  let d;try{d=JSON.parse(html);}catch{const raw=cheerio.load(html)('[data-page]').first().attr('data-page');if(!raw)throw new Error('Missing structured page');d=JSON.parse(raw);}
  if(!d||typeof d!=='object'||Array.isArray(d))throw new Error('Invalid page payload');
  return d.props||d;
}
function archive(html,page=1){
  const p=payload(html);
  if(!Array.isArray(p.data)||p.current_page!==page||!Number.isInteger(p.total)||p.total<0||p.per_page!==60||p.last_page!==Math.max(1,Math.ceil(p.total/60)))throw new Error('Invalid archive pagination');
  const count=Math.max(0,Math.min(60,p.total-(page-1)*60));
  if(p.data.length!==count||new Set(p.data.map(x=>x.id)).size!==count)throw new Error('Incomplete or repeated archive page');
  p.data.forEach(x=>{titlePath(x.id,x.slug);if(!['tv','movie'].includes(x.type))throw new Error('Invalid media type');});
  return p;
}
function normalize(value,origins){
  if(typeof value==='string'&&/^https?:\/\//.test(value))return reference(value,origins);
  if(Array.isArray(value))return value.map(v=>normalize(v,origins));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!['preview','created_by','embed_url'].includes(k)).map(([k,v])=>[k,normalize(v,origins)]));
}
function images(values,origins){return (values||[]).map(value=>{
  const raw=value.original_url_field||value.url||value.src||value.path||value.filename;
  if(typeof raw!=='string'||!raw)throw new Error('Invalid image reference');
  const ref=/^https?:\/\//.test(raw)?reference(raw,origins):{base:'images',path:'/images/'+raw.replace(/^\/+/, '')};
  return {...normalize(value,origins),reference:ref};
});}
function detail(html,id,origins,seasonNumber){
  const p=payload(html),t=p.title;
  if(p.locale&&p.locale!=='it')throw new Error('Unexpected detail locale');
  if(!t||t.id!==Number(id)||!['movie','tv'].includes(t.type)||!t.name||!Array.isArray(t.seasons))throw new Error('Invalid title page');
  if(Number.isInteger(t.seasons_count)&&t.seasons_count!==t.seasons.length)throw new Error('Incomplete season list');
  const cdn=new URL(p.cdn_url);if(cdn.protocol!=='https:'||cdn.username||cdn.password)throw new Error('Invalid image origin');origins.images=cdn.origin;
  if(new Set(t.seasons.map(x=>x.number)).size!==t.seasons.length||t.seasons.some(x=>!Number.isInteger(x.number)||x.number<0))throw new Error('Invalid seasons');
  const loaded=p.loadedSeason;
  if(seasonNumber!==undefined&&loaded?.number!==seasonNumber)throw new Error('Returned wrong season');
  let season;
  if(loaded){
    const declared=t.seasons.find(s=>s.number===loaded.number);
    if(!declared||declared.id!==loaded.id||loaded.title_id!==Number(id)||!Array.isArray(loaded.episodes))throw new Error('Invalid season inventory');
    if(Number.isInteger(declared.episodes_count)&&declared.episodes_count!==loaded.episodes.length)throw new Error('Incomplete season inventory');
    if(new Set(loaded.episodes.map(e=>e.id)).size!==loaded.episodes.length)throw new Error('Duplicate episode identity');
    season={...normalize(loaded,origins),path:titlePath(t.id,t.slug)+'/season-'+loaded.number,images:images(loaded.images,origins),episodes:loaded.episodes.map(e=>{
      if(!Number.isInteger(e.id)||e.id<=0||e.season_id!==loaded.id||!Number.isFinite(Number(e.number)))throw new Error('Invalid episode');
      return {...normalize(e,origins),images:images(e.images,origins)};
    })};
  }
  return {id:Number(id),provider:'streamingunity',locale:'it',path:titlePath(t.id,t.slug),
    sourceIds:Object.fromEntries(Object.entries(t).filter(([k])=>k.endsWith('_id'))),
    info:normalize({...t,seasons:undefined,images:undefined},origins),images:images(t.images,origins),
    seasonIndex:normalize(t.seasons,origins),season};
}
function sitemap(html){const $=cheerio.load(html,{xmlMode:true});if(!$('urlset').length)throw new Error('Invalid title sitemap');
  const out=new Map();$('url > loc').each((i,e)=>{const u=new URL($(e).text());const m=u.pathname.match(/^\/it\/titles\/(\d+)-([^/]+)$/);if(m)out.set(Number(m[1]),{id:Number(m[1]),slug:decodeURIComponent(m[2])});});if(!out.size)throw new Error('Empty title sitemap');return [...out.values()];}
module.exports={payload,archive,detail,sitemap,normalize};
