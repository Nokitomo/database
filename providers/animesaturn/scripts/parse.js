'use strict';
const cheerio = require('cheerio');
const {animePath, reference, normalizeData} = require('./urls');
const clean = value => String(value || '').replace(/\s+/g,' ').trim();
const integer = value => /^\d[\d,.]*$/.test(clean(value)) ? Number(clean(value).replace(/[,.]/g,'')) : null;
function document(html) {
  const $ = cheerio.load(html);
  if ($('meta[property="og:site_name"]').attr('content') !== 'AnimeSaturn' || !$('main').length)
    throw new Error('Invalid AnimeSaturn document');
  return $;
}
function card($, element, base, origins) {
  const a = $(element), identity = animePath(a.attr('href'), base);
  const title = clean(a.find('.ac__title').text());
  if (!title) throw new Error('Invalid archive card title');
  return {...identity, title, poster: reference(a.find('img').first().attr('src'), base, origins),
    type: clean(a.find('.ac__type-badge').text()), dubbed: Boolean(a.find('.ac__dub-badge').length),
    subtitle: clean(a.find('.ac__sub').text()), rating: Number(clean(a.find('.ac__score').text())) || null,
    adult: Boolean(a.find('.ac__adult').length)};
}
function parseArchive(html, base, page = 1, origins = {}, heading = 'Archivio anime') {
  const $ = document(html), main = $('main');
  if (clean(main.find('h1').text()) !== heading) throw new Error('Invalid archive heading');
  const total = integer(main.find('header .font-bold.text-brand').first().text());
  const pages = Math.ceil(total/30), current = Number(main.find('.page-num--active').text()) || 1;
  const cards = main.find('a.ac').map((_,e)=>card($,e,base,origins)).get();
  if (!total || current !== page || page > pages || cards.length !== Math.min(30,total-(page-1)*30) ||
    new Set(cards.map(value=>value.id)).size !== cards.length) throw new Error('Invalid archive pagination/count');
  return {total, pages, page, cards};
}
function schemas($, base, origins) {
  return $('script[type="application/ld+json"]').map((_,e)=>{
    try {return normalizeData(JSON.parse($(e).text()), base, origins);} catch {throw new Error('Invalid structured metadata');}
  }).get();
}
function images($, selector, kind, base, origins) {
  return $(selector).map((_,e)=>({kind, url:reference($(e).attr('src') || $(e).attr('content'),base,origins)})).get().filter(value=>value.url);
}
function parseAnime(html, base, expected, origins = {}) {
  const $ = document(html), title = clean($('main h1').text());
  const identity = animePath($('meta[property="og:url"]').attr('content') || expected.path,base);
  const story = $('.story-clip').first().length ? $('.story-clip').first() : $('.ag-story').first().clone();
  if (!title || identity.id !== expected.id || !$('.ag-meta').length || !story.length) throw new Error('Invalid anime identity/metadata');
  const fields = $('.ag-meta').children('a,div').map((_,e)=>{
    const label = clean($(e).children('span').first().text());
    const value = clean($(e).children('span').last().text());
    return label && value ? {label,value,link:reference($(e).attr('href'),base,origins)} : null;
  }).get();
  const field = name => fields.find(value=>value.label === name)?.value || null;
  if (!field('Stato') || !field('Tipo')) throw new Error('Incomplete anime metadata');
  const episodeSection = $('.ag-episodes');
  const countText = episodeSection.find('h2').text().match(/\((\d+)\)/)?.[1];
  const explicitEmpty = /nessun episodio|episodi non (?:ancora )?disponibili/i.test(episodeSection.text());
  const declaredAvailable = countText == null && explicitEmpty ? 0 : Number(countText);
  const episodes = episodeSection.find('a.ep-tile').map((_,e)=>{
    const a=$(e), route=animePath(a.attr('href'),base);
    if (route.id !== identity.id || !route.token) throw new Error('Invalid episode identity');
    return {id:`${identity.id}:${route.token}`, number:route.token.slice(3), label:clean(a.text()),
      path:route.episodePath, title:null, synopsis:null, thumbnail:null};
  }).get();
  if (!Number.isFinite(declaredAvailable) || declaredAvailable !== episodes.length ||
    new Set(episodes.map(value=>value.id)).size !== episodes.length) throw new Error('Incomplete episode inventory');
  const sourceIds = {};
  const externalLinks = $('.ag-links a[href]').map((_,e)=>{
    const url=$(e).attr('href');
    const match=url.match(/^https:\/\/(?:www\.)?(myanimelist\.net|anilist\.co)\/anime\/(\d+)/);
    if (match) sourceIds[match[1]==='anilist.co'?'anilist':'mal']=Number(match[2]);
    return {label:clean($(e).text()),url};
  }).get();
  const artwork = [...images($,'.ag-poster img','poster',base,origins),
    ...images($,'.anime-hero__bg','background',base,origins),
    ...images($,'meta[property="og:image"],meta[name="twitter:image"]','share',base,origins)];
  const status = {'Finito':'completed','In corso':'ongoing','Non rilasciato':'upcoming','Droppato':'dropped'}[field('Stato')] || 'unknown';
  return {schemaVersion:1,provider:'animesaturn',...identity,sourceIds,
    info:{title,originalTitle:clean($('main h1').next('p').text()),synopsis:clean(story.clone().find('h1,h2,h3,button,script,style').remove().end().text()),
      type:field('Tipo'),status,statusLabel:field('Stato'),audio:field('Lingua'),dubbed:/italian/i.test(field('Lingua')||''),
      season:field('Stagione'),year:Number(field('Data di uscita')?.match(/\b(19|20)\d{2}\b/)?.[0])||null,
      releaseDateLabel:field('Data di uscita'),studios:fields.filter(value=>value.label==='Studio').map(value=>value.value),
      genres:$('.ag-main a[href*="categories="]').map((_,e)=>clean($(e).text())).get(),
      declaredEpisodeCount:integer(field('Episodi')),availableEpisodeCount:episodes.length,durationLabel:field('Durata'),
      rating:Number($('#anime-score').text())||null,ratingCount:integer($('#anime-votes').text()),views:integer(field('Visualizzazioni')),
      poster:artwork.find(value=>value.kind==='poster')?.url||null},
    images:artwork,episodes,externalLinks,
    related:$('main a.ac').map((_,e)=>card($,e,base,origins)).get(),
    trailers:$('main iframe').filter((_,e)=>/youtube|vimeo/.test($(e).attr('src')||'')).map((_,e)=>reference($(e).attr('src'),base,origins)).get(),
    sourceMetadata:{fields,jsonLd:schemas($,base,origins),
      seo:$('meta[property^="og:"],meta[name="description"],meta[name="keywords"],meta[name^="twitter:"]')
        .map((_,e)=>({name:$(e).attr('property')||$(e).attr('name'),value:normalizeData($(e).attr('content'),base,origins)})).get()}};
}
function parseEpisode(html, base, anime, episode, origins={}) {
  const $=document(html), data=schemas($,base,origins).find(value=>value['@type']==='TVEpisode');
  const route=animePath($('meta[property="og:url"]').attr('content'),base);
  if (!data || route.id !== anime.id || route.episodePath !== episode.path || String(data.episodeNumber)!==String(episode.number)) throw new Error('Invalid episode metadata identity');
  // SEO descriptions/images usually repeat the series, so retain provenance
  // without promoting them to episode-specific synopsis/thumbnail fields.
  return {...episode, publishedAt:data.datePublished||null, sourceMetadata:{jsonLd:data},
    images:images($,'meta[property="og:image"],meta[name="twitter:image"]','share',base,origins)};
}
function parseFeed(text, base, page=1, origins={}) {
  const value=JSON.parse(text);
  if (value.page!==page || !Array.isArray(value.items) || !Number.isInteger(value.pages) ||
    !Number.isInteger(value.total) || value.hasNext!==(page<value.pages)) throw new Error('Invalid update feed');
  return {...value,items:value.items.map(item=>({...animePath(item.url,base),title:item.title,
    poster:reference(item.poster,base,origins),episodeLabel:item.episodeLabel,type:item.type}))};
}
function parseHomeImages(html,base,origins={}){
  const $=document(html), result={};
  $('.hero-title').each((_,element)=>{
    const slide=$(element).closest('.swiper-slide'),link=slide.find('a[href^="/anime/"]').first().attr('href');
    if(!link)return;
    const {id}=animePath(link,base);
    result[id]=slide.find('img').map((_,e)=>({kind:'banner',url:reference($(e).attr('src'),base,origins)})).get().filter(value=>value.url);
  });return result;
}
module.exports={parseArchive,parseAnime,parseEpisode,parseFeed,parseHomeImages,document};
