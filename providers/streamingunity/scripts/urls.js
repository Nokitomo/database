'use strict';
function siteOrigin(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||! /^(?:www\.)?streaming(?:unity|community)[a-z]*\.[a-z]{2,}$/i.test(u.hostname))throw new Error('Invalid provider origin');
  return u.origin;
}
function titlePath(id,slug){
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0||typeof slug!=='string'||!slug)throw new Error('Invalid title identity');
  return `/it/titles/${id}-${encodeURIComponent(slug)}`;
}
function reference(value,origins){
  if(typeof value!=='string')return value;
  if(value.startsWith('/'))return {base:'site',path:value};
  if(!/^https?:\/\//.test(value))return value;
  const u=new URL(value);
  for(const [base,origin]of Object.entries(origins))if(u.origin===origin)return {base,path:u.pathname+u.search+u.hash};
  return {url:u.href};
}
module.exports={siteOrigin,titlePath,reference};
