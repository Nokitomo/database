'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {performance}=require('node:perf_hooks');
const storage=new AsyncLocalStorage();
function service(url){
  const host=new URL(url).hostname.toLowerCase();
  if(host==='api.themoviedb.org')return 'tmdbApi';
  if(host==='www.themoviedb.org')return 'tmdbWeb';
  if(/(^|\.)thetvdb\.com$/.test(host))return 'tvdb';
  if(/(^|\.)wikidata\.org$/.test(host))return 'wikidata';
  return 'other';
}
function add(bucket,key,value=1){
  const data=storage.getStore();if(!data)return;
  const row=data[bucket]||(data[bucket]={});row[key]=(row[key]||0)+value;
}
async function request(url,fn,bucket=service(url)){
  if(!storage.getStore())return fn();
  const start=performance.now();add(bucket,'attempts');
  try{const result=await fn();add(bucket,'succeeded');return result;}
  catch(error){
    add(bucket,'failed');
    const status=Number(error?.response?.status);
    add(bucket,status>=100&&status<=599?'http'+status:'networkOrAbort');throw error;
  }finally{add(bucket,'requestMs',performance.now()-start);}
}
async function phase(bucket,fn){
  const start=performance.now();add(bucket,'calls');
  try{return await fn();}catch(error){add(bucket,'failures');throw error;}
  finally{add(bucket,'elapsedMs',performance.now()-start);}
}
async function capture(fn){
  const metrics={};
  return storage.run(metrics,async()=>({...await fn(),externalMetrics:metrics}));
}
module.exports={add,request,phase,capture,service};
