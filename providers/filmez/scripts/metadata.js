'use strict';
const cheerio=require('cheerio'),{reference,localPath}=require('./urls');
async function supplement(client,r,origins){
 const p=JSON.parse((await client.get('/wp-json/wp/v2/movie/'+r.id)).html);
 if(p.id!==r.id||p.type!=='movie'||localPath(p.link,origins.site)!==r.path)throw Error('Invalid detail API identity');
 const plain=v=>cheerio.load(String(v||''),null,false).text().replace(/\s+/g,' ').trim();
 r.info.synopsis ||= plain(p.content?.rendered)||null;
 r.info.publishedAt=p.date_gmt?p.date_gmt+'Z':r.info.publishedAt;r.info.modifiedAt=p.modified_gmt?p.modified_gmt+'Z':r.info.modifiedAt;
 r.sourceMetadata={slug:p.slug,genreIds:p.movie_genre||[],tagIds:p.movie_tag||[],featuredMediaId:p.featured_media||null,excerpt:plain(p.excerpt?.rendered)};
 if(p.featured_media){let response;try{response=await client.get('/wp-json/wp/v2/media/'+p.featured_media);}catch(e){if(![404,410].includes(e.status))throw e;r.warnings.push('featured-media-unavailable');r.sourceMetadata.featuredMediaStatus='missing';return r;}const m=JSON.parse(response.html);if(m.id!==p.featured_media||m.media_type!=='image'||!m.source_url)throw Error('Invalid featured media');
 const sizes=[{name:'original',source_url:m.source_url,width:m.media_details?.width,height:m.media_details?.height},...Object.entries(m.media_details?.sizes||{}).map(([name,v])=>({name,...v}))];
 for(const v of sizes){if(!v.source_url)continue;const ref=reference(v.source_url,origins),old=r.images.find(i=>JSON.stringify(i.reference)===JSON.stringify(ref));if(old){old.variants||=[];old.variants.push(v.name);continue;}r.images.push({role:'poster',reference:ref,width:v.width||null,height:v.height||null,language:null,variants:[v.name],alt:m.alt_text||null});}
 }
 r.info.poster ||= r.images.find(i=>i.role==='poster')?.reference||null;
 return r;
}
async function resolveAlias(client,html,id,origins,path){
 const {detail}=require('./parse'),r=detail(html,null,origins,path,'movie');
 const a=await client.get('/wp-json/wp/v2/movie/'+id),b=await client.get('/wp-json/wp/v2/movie/'+r.id);
 const left=JSON.parse(a.html),right=JSON.parse(b.html),plain=v=>cheerio.load(String(v||''),null,false).text().replace(/\s+/g,' ').trim();
 if(left.id!==Number(id)||right.id!==r.id||left.type!=='movie'||right.type!=='movie'||localPath(left.link,origins.site)!==path||localPath(right.link,origins.site)!==path||!plain(left.content?.rendered)||plain(left.title?.rendered)!==plain(right.title?.rendered)||plain(left.content?.rendered)!==plain(right.content?.rendered))throw Error('Conflicting provider alias identity');
 r.sourceAlias={canonicalId:r.id,method:'identical-provider-url-title-and-full-plot'};r.id=Number(id);r.warnings.push('verified-provider-duplicate-url');return r;
}
module.exports={supplement,resolveAlias};
