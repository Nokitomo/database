'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,PASTEBIN,FALLBACK}=require('../scripts/http');
const {connected}=require('../../../shared/warp/guard');
const f=require('./fixtures');
const response=(data,status=200,headers={})=>({data,status,headers});
function client(transport,extra={}){return new Client({transport,delay:0,wait:async()=>{},guard:()=>{},...extra});}

test('Pastebin discovery validates the live provider; unavailable candidate falls back',async()=>{
  const calls=[];const c=client(async req=>{calls.push(req.url);return req.url===PASTEBIN?
    response('https://www.animeworld.example'):req.url.includes('.example')?response('bad',503):response(f.home);});
  const d=await c.discover();assert.equal(d.source,'fallback');assert.equal(c.baseUrl,FALLBACK);
  assert.ok(calls.includes('https://www.animeworld.example/'));
  const bad=client(async req=>response(req.url===PASTEBIN?'https://www.animeworld.ac':'Challenge'));
  await assert.rejects(bad.discover(),/unavailable/);
});
test('session cookies and CSRF are reused only for the host that issued them',async()=>{
  const seen=[];const c=client(async req=>{seen.push(req);return response('<meta name="csrf-token" content="example-token">',200,
    {'set-cookie':['sessionId=example-session; Path=/; HttpOnly']});});
  await c.get(f.BASE+'/');await c.get(f.BASE+'/api/tooltip/1');await c.get(PASTEBIN);
  assert.equal(seen[1].headers.Cookie,'sessionId=example-session');assert.equal(seen[1].headers['CSRF-Token'],'example-token');
  assert.equal(seen[2].headers.Cookie,undefined);assert.equal(seen[2].headers['CSRF-Token'],undefined);
});
test('429 waits for Retry-After, retries are bounded, and 404 is not retried',async()=>{
  const waits=[];let count=0;
  const c=client(async()=>++count===1?response('',429,{'retry-after':'3'}):response('ok'),{wait:async ms=>waits.push(ms)});
  assert.equal((await c.get(f.BASE)).html,'ok');assert.ok(waits.includes(3000));
  count=0;const missing=client(async()=>{count++;return response('',404);});
  await assert.rejects(missing.get(f.BASE),{status:404});assert.equal(count,1);
  const excessive=client(async()=>response('',429,{'retry-after':'180'}));
  await assert.rejects(excessive.get(f.BASE),{status:429});
});
test('WARP loss blocks requests; off-provider redirects cannot receive cookies',async()=>{
  let requests=0;const c=client(async()=>{requests++;return response('ok');},{guard:()=>{throw new Error('WARP_REQUIRED: disconnected');}});
  await assert.rejects(c.discover(),/WARP_REQUIRED/);assert.equal(requests,0);
  const redirect=client(async()=>{requests++;return response('',302,{location:'https://example.org/'});});
  await assert.rejects(redirect.get(f.BASE),/Invalid AnimeWorld/);assert.equal(requests,1);
  assert.equal(connected('Status update: Connected'),true);assert.equal(connected('Status update: Disconnected'),false);
});
