'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const metrics=require('../shared/metrics');
const {createPacedGet}=require('../providers/animeunity/scripts/rate-limit');
const {createTmdbGet}=require('../providers/animeunity/scripts/tmdb-http');
test('batch metrics count retries, HTTP failures and limiter waits without leaking credentials',async()=>{
  let clock=0,calls=0;
  const get=createPacedGet(async()=>{
    calls++;clock+=10;
    if(calls===1)throw {response:{status:429,headers:{'retry-after':'2'}}};
    return {status:200};
  },{now:()=>clock,sleep:async ms=>{clock+=ms;}});
  const result=await metrics.capture(async()=>{
    await get('https://api.themoviedb.org/3/movie/1?api_key=SECRET');return {complete:true};
  });
  const m=result.externalMetrics.tmdbApi;
  assert.equal(m.attempts,2);assert.equal(m.failed,1);assert.equal(m.succeeded,1);
  assert.equal(m.http429,1);assert.equal(m.retryDecisions,1);assert.equal(m.limiterWaitMs,2000);
  assert(m.requestMs>=0);assert.equal(result.complete,true);
  assert(!JSON.stringify(result).includes('SECRET'));assert(!JSON.stringify(result).includes('/movie/'));
});
test('metrics isolate concurrent batches and reset between batches',async()=>{
  const results=await Promise.all(['tmdbApi','tvdb'].map(bucket=>metrics.capture(async()=>{
    metrics.add(bucket,'attempts');await new Promise(resolve=>setImmediate(resolve));
    metrics.add(bucket,'succeeded');return {};
  })));
  assert.deepEqual(Object.keys(results[0].externalMetrics),['tmdbApi']);
  assert.deepEqual(Object.keys(results[1].externalMetrics),['tvdb']);
  metrics.add('other','attempts');assert.deepEqual((await metrics.capture(async()=>({}))).externalMetrics,{});
});
test('web curl fallback has a separate counter and preserves responses',async()=>{
  const get=createTmdbGet(createPacedGet(async()=>{throw {response:{status:403}};}),{
    fallback:async()=>'<html>ok</html>',log:()=>{},
  });
  const result=await metrics.capture(async()=>({response:await get('https://www.themoviedb.org/movie/1')}));
  assert.equal(result.response.data,'<html>ok</html>');
  assert.equal(result.externalMetrics.tmdbWeb.http403,1);
  assert.equal(result.externalMetrics.tmdbWebCurl.succeeded,1);
});
test('network errors and failed phases preserve the original exception',async()=>{
  const error=new Error('private transport error');
  const result=await metrics.capture(async()=>{
    await assert.rejects(metrics.phase('tvdbPhases',()=>metrics.request('https://www.thetvdb.com',async()=>{throw error;})),e=>e===error);
    metrics.add('cache','checkpointHits');return {};
  });
  assert.equal(result.externalMetrics.tvdb.networkOrAbort,1);
  assert.equal(result.externalMetrics.tvdbPhases.failures,1);
  assert.equal(result.externalMetrics.cache.checkpointHits,1);
  assert(!JSON.stringify(result).includes(error.message));
});
