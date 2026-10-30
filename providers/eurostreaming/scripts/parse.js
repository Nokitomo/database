'use strict';
const cheerio=require('cheerio');
const {localPath,reference}=require('./urls');
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const ARCHIVE='/category/serie-tv-archive/';
function archive(html,base,page=1){
  const $=cheerio.load(html),items=[];
  if(!$('body').hasClass('category-serie-tv-archive'))throw Error('Invalid archive HTML');
  $('li[id^="post-"]').each((_,el)=>{const a=$(el).find('h2 a').first(),id=Number($(el).attr('id').slice(5));
    if(!id||!a.length||!clean(a.text()))throw Error('Invalid archive card');
    items.push({id,path:localPath(a.attr('href'),base),name:clean(a.text()),image:$(el).find('img').first().attr('src')||null});});
  const current=Number($('.page-numbers.current').text())||1;
  const pages=Math.max(current,...$('.page-numbers').toArray().map(e=>Number($(e).text())||0));
  if(current!==page||!items.length||new Set(items.map(x=>x.id)).size!==items.length||items.length>18||page<pages&&items.length!==18)throw Error('Incomplete or repeated archive page');
  return {items,pages,current};
}
function indexLinks(html,base,kind){
  const $=cheerio.load(html),links=new Set();
  const root=kind==='updates'?$('.post-entry, #main'):$('.entry');
  if(!root.length||!$('body').hasClass('page'))throw Error('Invalid index HTML');
  root.find('a[href]').each((_,e)=>{const href=$(e).attr('href');if(!href||href.startsWith('#'))return;
    if(kind==='updates'&&!/\d+\s*[x×]\s*\d+/i.test($(e).text()))return;
    try{const path=localPath(href,base);if(/^\/(?:elenco|category|nuovi-ep|film|facebook|richieste|guida)/.test(path)||path==='/')return;links.add(path);}catch{}});
  if(!links.size)throw Error('Empty discovery index');return [...links];
}
function connectedPage(html,base){
  const $=cheerio.load(html);if(!$('.nano_cp_button').length)return null;
  for(const script of $('script').toArray()){
    const match=$(script).html()?.match(/var\s+nano_ajax_object\s*=\s*(\{[^\n]+?\});/);
    if(match){const data=JSON.parse(match[1]);return localPath(data.go_to,base);}
  }
  throw Error('Episode page link missing');
}
function episodeBlocks($){
  const blocks=[];
  $('.su-spoiler').each((bi,node)=>{
    const heading=clean($(node).children('.su-spoiler-title').text());
    const sm=heading.match(/STAGIONE\s*(\d+)/i);if(!sm)return;
    const number=Number(sm[1]),language=/SUB\s*ITA/i.test(heading)?'sub-ita':/\bITA\b/i.test(heading)?'ita':'unknown';
    const content=$(node).children('.su-spoiler-content').clone();content.find('br').replaceWith('\n');content.find('p').append('\n');
    const episodes=[],unparsed=[];let variant='default';
    const lines=(content.html()||'').split('\n');
    for(const line of lines){const l=cheerio.load(line),text=clean(l.root().text());if(!text)continue;
      if(/version[ei] alternativ/i.test(text)){variant=text;continue;}
      const m=text.match(/^(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?)\s*(.*)$/i);
      if(!m){if(l('a[href]').length)unparsed.push(text);continue;}
      const label=m[2].replace(/\s/g,''),n=/^\d+(?:[.,]\d+)?$/.test(label)?Number(label.replace(',','.')):label;
      const title=clean(m[3].split(/\s+[–—]\s+/)[0]).replace(/\s+-\s*(?:MaxStream|DeltaBit|MixDrop|Turbovid).*$/i,'').trim();
      const links=l('a[href]').toArray().map(e=>({name:clean(l(e).text()),url:l(e).attr('href').trim()})).filter(x=>/^https?:\/\//i.test(x.url));
      episodes.push({number:n,label,seasonNumber:Number(m[1]),name:title||null,language,variant,availability:links.length?'listed':'announced',links});
    }
    blocks.push({id:bi,number,heading,language,announced:/coming soon|prossimamente/i.test(content.text())&&!episodes.length,episodes,unparsed});
  });
  return blocks;
}
function detail(html,expected,origins,path,episodeHtml=null){
  const $=cheerio.load(html),id=Number(($('body').attr('class')||'').match(/\bpostid-(\d+)\b/)?.[1]);
  const content=$('.post-entry .entry-content').first(),name=clean($('h1.entry-title').first().text());
  if(!id||expected&&id!==Number(expected)||!name||!content.length)throw Error('Invalid detail identity/HTML');
  const blocks=episodeBlocks(episodeHtml?cheerio.load(episodeHtml):$),warnings=[];
  const connected=connectedPage(html,origins.site);if(connected&&!episodeHtml)throw Error('Connected episode page not loaded');
  if(!blocks.length)throw Error('Episode layout not recognized');
  if(blocks.some(b=>b.unparsed.length))throw Error('Unparsed episode rows');
  const seasons=new Map();
  for(const b of blocks){let s=seasons.get(b.number);if(!s){s={id:b.number,number:b.number,images:[],episodes:[],blocks:[]};seasons.set(b.number,s);}s.blocks.push(b.id);
    for(const ep of b.episodes){if(ep.seasonNumber!==b.number)warnings.push('ambiguous-episode-numbering');
      let e=s.episodes.find(v=>String(v.number)===String(ep.number));
      if(!e){e={id:b.number+':'+ep.label,number:ep.number,label:ep.label,name:ep.name,images:[],variants:[],metadataMappingStatus:'unverified'};s.episodes.push(e);}
      if(e.variants.some(v=>v.language===ep.language&&(v.name!==ep.name||v.variant!==ep.variant)))warnings.push('ambiguous-episode-numbering');
      e.variants.push({...ep,block:b.id});if(ep.language==='ita')e.name=ep.name;
    }
  }
  // Even regular integer coordinates require cross-provider agreement before enrichment.
  const paragraphs=content.children('p').toArray().map(e=>{const q=$(e).clone();q.find('a,button').remove();return clean(q.text());}).filter(t=>t&&!/^Link disponibili/i.test(t));
  const plot=paragraphs.join('\n').replace(/\s*Continua a leggere\.?/g,'').trim();
  const year=Number(plot.match(/(?:del|nel|dal|iniziata nel|prodotta nel)\s+(19\d{2}|20\d{2})\b/i)?.[1])||Number(name.match(/\((19\d{2}|20\d{2})\)/)?.[1])||null;
  const sourceIds={};content.find('a[href]').each((_,e)=>{let u;try{u=new URL($(e).attr('href'),origins.site);}catch{return;}
    if(/(^|\.)imdb\.com$/i.test(u.hostname)){const m=u.pathname.match(/\/title\/(tt\d+)/);if(m)sourceIds.imdb_id=m[1];}
    if(/(^|\.)themoviedb\.org$/i.test(u.hostname)){const m=u.pathname.match(/\/tv\/(\d+)/);if(m)sourceIds.tmdb_id=Number(m[1]);}
    if(/(^|\.)thetvdb\.com$/i.test(u.hostname)&&u.searchParams.get('tab')==='series'&&/^\d+$/.test(u.searchParams.get('id')||''))sourceIds.tvdb_id=Number(u.searchParams.get('id'));
  });
  const images=[];content.find('img').each((_,e)=>{const src=$(e).attr('data-src')||$(e).attr('src');if(src)images.push({role:'poster',reference:reference(src,origins),language:null});});
  const description=clean($('meta[name="description"]').attr('content'))||null;
  const categories=($('.post-entry').attr('class')||'').split(/\s+/).filter(c=>c.startsWith('category-')).map(c=>c.slice(9));
  const tags=($('.post-entry').attr('class')||'').split(/\s+/).filter(c=>c.startsWith('tag-')).map(c=>c.slice(4));
  const relatedLinks=[];content.children('p').find('a[href]').each((_,e)=>{const href=$(e).attr('href');try{const u=new URL(href,origins.site);if(!['https:','http:'].includes(u.protocol))return;
    let ref;try{ref={base:'site',path:localPath(u.href,origins.site)};}catch{ref={url:u.href};}relatedLinks.push({label:clean($(e).text()),reference:ref});}catch{}});
  return {schemaVersion:1,provider:'eurostreaming',locale:'it',id,active:true,path,sourceIds,info:{name,type:'tv',year,plot,description,categories,tags,relatedLinks},images,
    episodePage:connected?{base:'site',path:connected}:null,episodeBlocks:blocks,episodeMappingUncertain:true,
    seasons:[...seasons.values()],seasonIndex:[...seasons.values()].map(s=>({id:s.id,number:s.number,episodes_count:s.episodes.length})),warnings:[...new Set(warnings)]};
}
module.exports={ARCHIVE,archive,indexLinks,connectedPage,episodeBlocks,detail};
