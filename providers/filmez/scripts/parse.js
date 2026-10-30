'use strict';
const cheerio=require('cheerio'),{localPath,reference}=require('./urls');
const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
const text=v=>clean(cheerio.load(String(v||''),null,false).text());
function apiArchive(response,base,kind,page,perPage=100){
 const data=JSON.parse(response.html),total=Number(response.headers?.['x-wp-total']),pages=Number(response.headers?.['x-wp-totalpages']);
 if(!Array.isArray(data)||!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(pages)||pages!==Math.ceil(total/perPage)||data.length!==Math.max(0,Math.min(perPage,total-(page-1)*perPage)))throw Error('Invalid API archive coverage');
 const items=data.map(r=>{if(!Number.isSafeInteger(r.id)||r.id<=0||r.type!==kind||!r.title?.rendered||!/^\d{4}-\d{2}-\d{2}T/.test(r.modified_gmt||''))throw Error('Invalid API archive card');
 return {id:r.id,path:localPath(r.link,base),name:text(r.title.rendered),kind,modified:r.modified_gmt,published:r.date_gmt||null};});
 if(new Set(items.map(r=>r.id)).size!==items.length)throw Error('Repeated archive ID');return {items,total,pages:Math.max(1,pages),current:page};
}
function htmlArchive(html,base,kind,page){
 const $=cheerio.load(html),size=kind==='movie'?24:30;
 if(!$('body').hasClass('post-type-archive-'+kind))throw Error('Invalid archive HTML');
 const count=clean($('.masvideos-result-count').first().text()),m=count.match(/(\d+)\s*[–-]\s*(\d+)\s*(?:of|di)\s*(\d+)/i);
 if(!m)throw Error('Missing archive total');const total=Number(m[3]),pages=Math.ceil(total/size),items=[];
 $(kind==='movie'?'#primary .movies__inner > .type-movie':'#primary .tv-shows__inner > .type-tv_show').each((_,e)=>{const node=$(e),id=Number(node.attr('class').match(/\bpost-(\d+)\b/)?.[1]);
 const a=node.find(kind==='movie'?'a.movie__link':'a.tv-show__link').first(),name=clean(node.find('h3').first().text());
 if(!id||!name||!a.length)throw Error('Invalid archive card');items.push({id,path:localPath(a.attr('href'),base),name,kind});});
 if(Number(m[1])!==(page-1)*size+1||Number(m[2])!==Math.min(page*size,total)||items.length!==Math.min(size,total-(page-1)*size)||new Set(items.map(i=>i.id)).size!==items.length)throw Error('Incomplete or repeated archive page');
 return {items,total,pages,current:page};
}
function detail(html,expected,origins,path,kind){
 if(kind!=='movie')throw Error('Unsupported Filmez media type');
 const $=cheerio.load(html),body=$('body'),id=Number(body.attr('class')?.match(/\bpostid-(\d+)\b/)?.[1]);
 if(!id||expected&&id!==Number(expected)||!body.hasClass('single-'+kind))throw Error('Invalid detail identity');
 const main=$(kind==='movie'?'.movie':'.tv-show').first().clone();main.find('.movie__related,.tv-show__related,.tv-show-related,section.related,.type-tv_show,.type-movie').remove();
 const title=clean(main.find('h1.entry-title').first().text());if(!title)throw Error('Missing title');
 const schemas=[],warnings=[];main.find('script[type="application/ld+json"]').add($('head script[type="application/ld+json"]')).each((_,e)=>{try{const v=JSON.parse($(e).html());schemas.push(...(v['@graph']||[v]));}catch{warnings.push('invalid-jsonld');}});
 const movie=schemas.find(v=>v['@type']==='Movie')||{},web=schemas.find(v=>v['@type']==='WebPage')||{};
 const description=main.find(kind==='movie'?'.movie__description':'.tv-show__description').first().clone();description.find('h2,h3,h4').remove();
 const synopsis=clean(description.text())||clean(main.find('.right-div p').map((_,e)=>$(e).text()).get().join(' '))||text(movie.description)||null;
 const releaseDates=clean(main.find('.tv-show__meta--release-year').first().text()),rawMetadata=clean(main.find('.movie_meta').first().text())||clean(main.find('.right-div b').first().text());
 const year=Number(releaseDates.match(/\b(19\d{2}|20\d{2})\b/)?.[1]||rawMetadata.match(/Anno\s*(\d{4})/)?.[1])||null;
 const genres=[...new Set(main.find('.tv-show__meta--genre a,.movie__meta--genre a').toArray().map(e=>clean($(e).text())))];
 for(const genre of (rawMetadata.match(/Genere\s+([^|]+)/i)?.[1]||'').split(',').map(clean).filter(Boolean))if(!genres.includes(genre))genres.push(genre);
 const sourceIds={};main.find('a[href]').each((_,e)=>{try{const u=new URL($(e).attr('href'),origins.site),p=u.pathname;
  if(/(^|\.)anilist\.co$/.test(u.hostname)&&/^\/anime\/\d+/.test(p))sourceIds.anilistId=Number(p.split('/')[2]);
  if(/(^|\.)myanimelist\.net$/.test(u.hostname)&&/^\/anime\/\d+/.test(p))sourceIds.malId=Number(p.split('/')[2]);
  if(/(^|\.)imdb\.com$/.test(u.hostname)&&/\/title\/tt\d+/.test(p))sourceIds.imdb_id=p.match(/tt\d+/)[0];
  if(/(^|\.)themoviedb\.org$/.test(u.hostname)&&/^\/(tv|movie)\/\d+/.test(p)){sourceIds.tmdb_id=Number(p.split('/')[2]);sourceIds.tmdb_type=p.split('/')[1];}
 }catch{}});
 const images=[],seenImages=new Set();
 const addImage=(url,role,width=null,height=null)=>{if(!url)return;const ref=reference(url,origins),key=JSON.stringify(ref);if(seenImages.has(key))return;seenImages.add(key);images.push({role,reference:ref,width:Number(width)||null,height:Number(height)||null,language:null});};
 main.find('img').each((_,e)=>{const image=$(e),src=image.attr('src');if(!src||/\/player\/|32x32|avatar|gravatar/.test(src))return;
  const role=/backdrop|background/.test(image.attr('class')||'')?'background':'poster';addImage(src,role,image.attr('width'),image.attr('height'));
  // WordPress filenames can contain commas: only split srcset at width descriptors.
  const set=image.attr('srcset')||'';for(const m of set.matchAll(/(?:^|\s*,\s*)(https?:\/\/\S+?)\s+(\d+)w(?=\s*,|$)/g))addImage(m[1],role,m[2]);
 });
 addImage($('meta[property="og:image"]').attr('content'),'poster',$('meta[property="og:image:width"]').attr('content'),$('meta[property="og:image:height"]').attr('content'));
 addImage(typeof movie.image==='string'?movie.image:null,'poster');
 for(const el of main.find('[style]').toArray()){const style=$(el).attr('style');for(const m of style.matchAll(/background(?:-image)?\s*:[^;]*url\(['"]?([^'")]+)['"]?\)/gi))addImage(m[1],'background');}
 const linksOf=node=>node.find('a[href]').toArray().map(e=>({label:clean($(e).text()),url:$(e).attr('href')})).filter(v=>/^https?:\/\//i.test(v.url||'')).map(v=>{
  let ref;try{ref={base:'site',path:localPath(v.url,origins.site)};}catch{ref={url:v.url};}return {label:v.label,reference:ref};});
 const seasons=new Map(),episodes=[],rows=[];
 const declaredEmpty=/coming soon|prossimamente|nessun episodio/i.test(main.text());
 const playback=kind==='movie'?linksOf(main.find('.summary').first()).filter(v=>/stream|scarica|download|mixdrop|delta|turbovid/i.test(v.label)):[];
 const info={title,name:title,type:kind==='movie'?'movie':'tv',synopsis,year,releaseDates:releaseDates||null,genres,
  description:clean($('meta[name="description"]').attr('content'))||null,rawMetadata:rawMetadata||null,
  country:rawMetadata.match(/Nazione\s+([^|]+)/i)?.[1]?.trim()||null,runtime:Number(rawMetadata.match(/Durata\s+(\d+)/i)?.[1])||null,
  director:movie.director||clean(main.find('b').toArray().map(e=>clean($(e).text())).find(t=>/^Regia:/i.test(t))?.replace(/^Regia:\s*/i,''))||null,
  cast:movie.actor||[...new Set(main.find('a[href*="/attori/"]').toArray().map(e=>clean($(e).text())))],
  rating:movie.aggregateRating||(rawMetadata.match(/Valutazione\s+([\d.,]+)/i)?{ratingValue:rawMetadata.match(/Valutazione\s+([\d.,]+)/i)[1],ratingCount:rawMetadata.match(/Voti\s+(\d+)/i)?.[1]||null}:null),publishedAt:web.datePublished||$('meta[property="article:published_time"]').attr('content')||null,modifiedAt:web.dateModified||$('meta[property="og:updated_time"]').attr('content')||null,
  poster:images.find(v=>v.role==='poster')?.reference||null,background:images.find(v=>v.role==='background')?.reference||null,
  status:declaredEmpty?'announced':'unknown',availableEpisodeCount:episodes.length};
 return {schemaVersion:1,provider:'filmez',locale:'it',id,active:true,path,sourceIds,info,images,episodes,seasons:[...seasons.values()],
  seasonIndex:[...seasons.values()].map(s=>({id:s.id,number:s.number,episodes_count:s.episodes.length})),sourceRows:rows,playback,
  metadataComplete:!warnings.includes('unparsed-episode-label'),warnings:[...new Set(warnings)]};
}
module.exports={apiArchive,htmlArchive,detail};
