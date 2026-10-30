'use strict';
const BASE='https://www.animeworld.ac';
const code=id=>`code-${id}`;
const identity=id=>({id,code:code(id),path:`/play/title-${id}.${code(id)}`});
const shell=body=>`<html><head><meta id="siteName" content="AnimeWorld"></head><body>${body}</body></html>`;
function card(id,token='') {return `<div class="item"><a class="poster" data-tip="api/tooltip/${id}" href="${identity(id).path}${token?'/'+token:''}"><img src="https://img.animeworld.ac/locandine/${id}.jpg"></a><a class="name" data-jtitle="Original ${id}" href="${identity(id).path}${token?'/'+token:''}">Title ${id}</a><p>Synopsis</p>${token?'<div class="ep">Ep '+token+'</div>':''}</div>`;}
function listing(ids,{page=1,total=ids.length,pages=Math.ceil(total/25),archive=true,token=''}={}) {
  return shell(`<div id="main">${archive?`<div class="az-list"><span class="az-total">${total} anime</span><div class="items">`:'<div class="film-list">'}${ids.map(id=>card(id,token)).join('')}</div>${archive?'</div>':''}<form id="paging-form"><input id="page-input" placeholder="${page}"><span class="total">${pages}</span></form></div>`);
}
function episode(id,num,server='9'){return `<div class="server" data-name="${server}"><ul class="episodes"><li class="episode"><a data-episode-id="${id}" data-id="token-${id}" data-episode-num="${num}" data-base="${num}" href="${identity(1).path}/token-${id}">${num}</a></li></ul></div>`;}
function anime(id=1,{count=2,status='Finito',declared=count,body='',episodes,domain=BASE}={}) {
  const fields={Categoria:'Anime',Audio:'Giapponese','Data di Uscita':'1 Gennaio 2020',Stagione:'Inverno 2020',
    Studio:'<a href="/filter?studio=Studio">Studio</a>',Genere:'<a href="/genre/action">Azione</a>',
    Durata:'24 min/ep',Episodi:String(declared),Stato:status,Visualizzazioni:'1.234'};
  const eps=episodes ?? Array.from({length:count},(_,i)=>episode(100+i,i+1)).join('').replaceAll(identity(1).path,identity(id).path);
  return shell(`<meta name="og:url" content="${domain}${identity(id).path}"><meta name="og:image" content="https://img.animeworld.ac/copertine/${id}.jpg">
    <script>window.animeId="${id}";window.animeIdentifier="${code(id)}";window.animeDub=false;</script>
    <div id="main"><h1 id="anime-title" data-jtitle="Original ${id}">Title ${id}</h1><div id="loveButton" data-id="${id}"></div>
    ${count===0?'<img id="unavailable">':''}${eps}
    <div class="widget info"><img src="https://img.animeworld.ac/locandine/${id}.jpg"><div class="rating" data-value="8.1" data-count="123"></div><dl class="meta">${Object.entries(fields).map(([k,v])=>`<dt>${k}:</dt><dd>${v}</dd>`).join('')}</dl><div class="desc">A complete synopsis.</div></div>
    <a id="mal-button" href="https://myanimelist.net/anime/21">MAL</a>
    <div class="trailer-show"><iframe src="https://www.youtube.com/embed/example"></iframe></div>${body}</div>`);
}
const tooltip=id=>`<div class="inner"><div class="title"><h1 data-jtitle="Original ${id}">Title ${id}</h1></div><p class="desc">Synopsis</p><div class="meta"><label>Nome alternativo:</label><span>Other title ${id}</span></div></div><a class="watch-now" href="${identity(id).path}">Watch</a>`;
const home=shell('<a href="/az-list">Archive</a><div style="background-image:url(https://img.animeworld.ac/slider/1.jpg)"><a href="/play/title-1.code-1">Title</a></div>');
const schedule=shell('<div class="sch-tabs"></div>');
module.exports={BASE,code,identity,shell,card,listing,episode,anime,tooltip,home,schedule};
