'use strict';
function siteOrigin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^(www\.)?animetop\.[a-z]{2,}$/i.test(u.hostname))throw Error('Invalid AnimeTop origin');return u.origin;}
function allowedOrigin(value){try{return siteOrigin(value);}catch{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^(www\.)?eurostreamings\.[a-z]{2,}$/i.test(u.hostname))throw Error('Invalid discovery origin');return u.origin;}}
function localPath(value,base){const u=new URL(value,base);siteOrigin(u.href);return u.pathname+u.search;}
function reference(value,origins){const u=new URL(value,origins.site);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid image URL');
 if(/^(www\.)?animetop\.[a-z]{2,}$/i.test(u.hostname))return {base:'site',path:u.pathname+u.search};
 let key=Object.keys(origins).find(k=>origins[k]===u.origin);if(!key){key='images'+Object.keys(origins).filter(k=>k.startsWith('images')).length;origins[key]=u.origin;}return {base:key,path:u.pathname+u.search};}
module.exports={siteOrigin,allowedOrigin,localPath,reference};
