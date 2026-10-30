'use strict';
function siteOrigin(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||! /^(www\.)?altadefinizionex\.[a-z]{2,}$/i.test(u.hostname))throw Error('Invalid provider origin');
  return u.origin;
}
function titlePath(id,slug,kind='movie') {
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0||typeof slug!=='string'||!slug.trim())throw Error('Invalid title identity');
  return `/${kind==='series'?'serie-tv':'film'}/${id}-${encodeURIComponent(slug)}-streaming.html`;
}
function reference(value,origins) {
  const u=new URL(value);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid URL');
  if(u.origin===origins.site)return {base:'site',path:u.pathname+u.search+u.hash};
  if(/^img\.altadefinizionex\.[a-z]{2,}$/i.test(u.hostname)) {
    origins.images ||= u.origin;return {base:'images',path:u.pathname+u.search+u.hash};
  }
  return {url:u.href};
}
module.exports={siteOrigin,titlePath,reference};
