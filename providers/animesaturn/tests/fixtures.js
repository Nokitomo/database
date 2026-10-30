'use strict';
const BASE='https://www.animesaturn.net';
const id=n=>String(n).padStart(5,'0');
const route=n=>`/anime/test-${id(n)}`;
const doc=(main,meta='')=>`<html><head><meta property="og:site_name" content="AnimeSaturn">${meta}</head><body><a href="/az-list">Archivio anime</a><main>${main}</main></body></html>`;
const home=doc('<h1>AnimeSaturn</h1>');
const card=n=>`<a class="ac" href="${route(n)}"><img src="https://img.saturncdn.net/static/${n}.jpg"><h3 class="ac__title">Test ${n}</h3><span class="ac__type-badge">TV</span><p class="ac__sub">2026 · 1 ep</p></a>`;
function archive(total=125,page=1,heading='Archivio anime'){
  return doc(`<header><h1>${heading}</h1><span class="font-bold text-brand">${total.toLocaleString('en-US')}</span></header>`+
    Array.from({length:Math.max(0,Math.min(30,total-(page-1)*30))},(_,i)=>card((page-1)*30+i+1)).join('')+`<span class="page-num--active">${page}</span>`);
}
function anime(n,count=1,declared=count){
  const metadata=[['Tipo','TV'],['Stato','Finito'],['Lingua','Giapponese'],['Episodi',String(declared)],['Data di uscita','1 Gennaio 2026']];
  return doc(`<h1>Test ${n}</h1><p>Original title</p><div class="ag-meta">${metadata.map(([k,v])=>`<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>`+
    `<div class="story-clip">Test synopsis</div><div class="ag-poster"><img src="https://img.saturncdn.net/static/${n}.jpg"></div>`+
    `<div class="ag-links"><a href="https://anilist.co/anime/${n}/">AniList</a><a href="https://myanimelist.net/anime/${n}/">MAL</a></div>`+
    `<div class="ag-episodes"><h2>Episodi (${count})</h2>${Array.from({length:count},(_,i)=>`<a class="ep-tile" href="/episode/test-${id(n)}/ep-${i+1}">${i+1}</a>`).join('')}</div>`,
    `<meta property="og:url" content="${BASE}${route(n)}">`);
}
function episode(n,number=1){const url=`${BASE}/episode/test-${id(n)}/ep-${number}`;return doc('<h1>Episode</h1>',
  `<meta property="og:url" content="${url}"><meta property="og:image" content="https://img.saturncdn.net/share.jpg">`+
  `<script type="application/ld+json">${JSON.stringify({'@type':'TVEpisode',episodeNumber:String(number),datePublished:'2026-01-01',url,description:'Series SEO synopsis'})}</script>`);}
function client(total=125,episodes=1){return {baseUrl:BASE,calls:[],async discover(){return {html:home,source:'pastebin',baseUrl:BASE};},async get(url){
  this.calls.push(url);
  if(url.startsWith('/az-list'))return {html:archive(total,Number(url.split('/')[2])||1)};
  if(url.startsWith('/newest'))return {html:archive(total,Number(url.split('/')[2])||1,'Nuove aggiunte')};
  if(url.startsWith('/api/home/episodes'))return {html:JSON.stringify({items:[],page:1,pages:1,total:0,hasPrev:false,hasNext:false})};
  let m=url.match(/^\/anime\/test-(\d+)/);if(m)return {html:anime(Number(m[1]),episodes)};
  m=url.match(/^\/episode\/test-(\d+)\/ep-(\d+)/);if(m)return {html:episode(Number(m[1]),Number(m[2]))};
  throw new Error('Unexpected URL '+url);
}};}
module.exports={BASE,id,route,doc,home,archive,anime,episode,client};
