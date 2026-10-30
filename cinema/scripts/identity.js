'use strict';
const path=require('node:path');
const cheerio=require('cheerio');
const {read,write,hash}=require('../../shared/storage/json');
const {createContext}=require('../../scripts/vega');
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\(\d{4}\)/g,'').replace(/[^\p{L}\p{N}]/gu,'');
async function resolve(record,{context,apiKey=process.env.TMDB_API_KEY}={}){
  const type=record.info.type==='movie'?'movie':'tv',imdb=record.sourceIds.imdb_id;
  const request=async(p,params={})=>{
    const key=String(apiKey||'').trim(),bearer=/^(?:Bearer\s+)?eyJ/.test(key);
    const r=await context.axios.get('https://api.themoviedb.org/3'+p,{params:{...params,...(bearer?{}:{api_key:key})},headers:bearer?{Authorization:'Bearer '+key.replace(/^Bearer\s+/i,'')}:{}});
    if(!r.data||r.data.success===false)throw Error('Invalid TMDB identity response');return r.data;
  };
  let candidates=[],apiError=false;
  if(apiKey)try{
    const data=imdb?await request('/find/'+imdb,{external_source:'imdb_id'}):await request('/search/'+type,{query:record.info.name,language:'it-IT',...(record.info.year?{[type==='tv'?'first_air_date_year':'year']:record.info.year}:{})});
    candidates=imdb?data[type==='tv'?'tv_results':'movie_results']:data.results;
    if(!Array.isArray(candidates))throw Error('Invalid TMDB identity results');
    candidates=candidates.filter(c=>Number.isSafeInteger(Number(c.id))&&Number(c.id)>0);
    if(imdb&&candidates.length===1){const id=Number(candidates[0].id),external=await request(`/${type}/${id}/external_ids`);
      if(external.imdb_id===imdb)return {status:'verified',method:'tmdb-imdb-backlink',tmdb_id:id,...(external.tvdb_id?{tvdb_id:external.tvdb_id}:{})};
    }
  }catch{apiError=true;}
  if(!apiKey||apiError){
    const url='https://www.themoviedb.org/search/'+type+'?query='+encodeURIComponent(imdb||record.info.name);
    const {data}=await context.axios.get(url);const $=cheerio.load(data);
    if(!$('title').text().includes('Movie Database')||/just a moment|access denied/i.test($('title').text()))throw Error('Invalid TMDB search page');
    const found=new Map();$('a[href]').each((_,e)=>{const h=$(e).attr('href'),m=h.match(new RegExp('^/'+type+'/(\\d+)(?:-|$)'));if(m)found.set(Number(m[1]),{id:Number(m[1]),name:$(e).text().trim()});});
    candidates=[...found.values()].slice(0,10);
    if(imdb){const verified=[];for(const c of candidates.slice(0,5)){
      const html=(await context.axios.get(`https://www.themoviedb.org/${type}/${c.id}`)).data,$d=cheerio.load(html);
      if(/just a moment|access denied/i.test($d('title').text()))throw Error('Blocked TMDB identity detail');
      if($d('a[href]').toArray().some(e=>{try{const u=new URL($d(e).attr('href'));return /(^|\.)imdb\.com$/.test(u.hostname)&&u.pathname.split('/').includes(imdb);}catch{return false;}}))verified.push(c.id);
    }if(verified.length===1)return {status:'verified',method:'tmdb-web-imdb-backlink',tmdb_id:verified[0]};}
  }
  return {status:candidates.length?'needs-review':'unmapped',candidates:candidates.slice(0,10).map(c=>({tmdb_id:c.id,title:c.name||c.title||null,year:(c.first_air_date||c.release_date||'').slice(0,4)||null})),reason:imdb?'external-id-not-confirmed':'no-provider-external-id'};
}
async function identify(source,{output,providerRoot,now,deadline,limit=10,lookup=resolve}){
  const file=path.join(output,'identity.json'),state=read(file,{});let processed=0,pending=0,immediate=false;
  for(const e of source.entries.filter(e=>e.provider==='eurostreaming')){
    const r=e.record;if(!r.active)continue;
    // Direct IDs already support grouping. Local matches also supply IDs without requests.
    const other=source.entries.filter(v=>v.provider!=='eurostreaming'&&v.record.info.type===r.info.type);
    const shared=other.filter(v=>Object.entries(r.sourceIds).some(([k,id])=>id&&String(v.record.sourceIds?.[k])===String(id)));
    const consistent=shared.filter(v=>Object.entries(r.sourceIds).every(([k,id])=>!id||!v.record.sourceIds[k]||String(v.record.sourceIds[k])===String(id)));
    if(!r.sourceIds.tmdb_id&&consistent.length&&consistent.every(v=>String(v.record.sourceIds.tmdb_id||'')===String(consistent[0].record.sourceIds.tmdb_id||''))){
      if(consistent[0].record.sourceIds.tmdb_id)r.sourceIds={...consistent[0].record.sourceIds,...r.sourceIds};
    }
    if(r.sourceIds.tmdb_id)continue;
    const fingerprint=hash({ids:r.sourceIds,name:r.info.name,year:r.info.year,type:r.info.type}),old=state[e.key];
    let cached=old?.fingerprint===fingerprint?old:null;
    if(!cached||cached.nextCheckAt<=now){
      if(processed<limit&&Date.now()<deadline-1000){processed++;
        try{const result=await lookup(r,{context:createContext(providerRoot,'https://source.invalid',null,{signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))})});
          cached=state[e.key]={fingerprint,...result,nextCheckAt:now+(result.status==='verified'?30:7)*86400000};
        }catch{cached=state[e.key]={fingerprint,status:'retry',nextCheckAt:now+3600000,
          ...(cached?.tmdb_id?{tmdb_id:cached.tmdb_id,tvdb_id:cached.tvdb_id,method:cached.method,retainedVerifiedIdentity:true}:{})};}
        write(file,state);
      }else{immediate=true;pending++;}
    }
    if(cached?.status==='verified'||cached?.retainedVerifiedIdentity){r.sourceIds.tmdb_id=cached.tmdb_id;if(cached.tvdb_id&&!r.sourceIds.tvdb_id)r.sourceIds.tvdb_id=cached.tvdb_id;}
    r.identity=cached?{status:cached.status,method:cached.method,candidates:cached.candidates,reason:cached.reason}:{status:'pending'};
    if(cached?.status==='retry')pending++;
    if(!r.sourceIds.imdb_id&&!r.sourceIds.tmdb_id){r.identity.localCandidates=other.filter(v=>norm(v.record.info.name)===norm(r.info.name)&&(!r.info.year||!v.record.info.year||String(r.info.year)===String(v.record.info.year))).map(v=>v.key).slice(0,20);}
  }
  return {pending,immediate,processed};
}
module.exports={identify,resolve};
