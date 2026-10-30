'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../scripts/parse'),u=require('../scripts/urls'),{hash}=require('../scripts/store');
const {checkReferences}=require('../scripts/verify');
const f=require('./fixtures');

test('source-only anime keeps metadata, artwork, external IDs and all 1180 episodes',()=>{
  const origins={}; const r=p.parseAnime(f.anime(1,{count:1180,declared:'??',status:'In corso'}),f.BASE,f.identity(1),origins);
  assert.equal(r.episodes.length,1180);assert.equal(r.episodes.at(-1).number,'1180');
  assert.equal(r.info.declaredEpisodeCount,null);assert.equal(r.info.views,1234);
  assert.deepEqual(r.sourceIds,{mal:21});assert.equal(r.info.genres[0],'Azione');
  assert.equal(r.info.poster.base,'img');assert.equal(r.trailers[0].url,'https://www.youtube.com/embed/example');
  checkReferences(r,origins);
});
test('an announced episode total never invents available episodes',()=>{
  const r=p.parseAnime(f.anime(1,{count:0,status:'Non rilasciato',declared:7}),f.BASE,f.identity(1));
  assert.equal(r.info.declaredEpisodeCount,7);assert.equal(r.episodes.length,0);assert.equal(r.info.status,'upcoming');
  const partial=p.parseAnime(f.anime(1,{count:6,declared:12}),f.BASE,f.identity(1));assert.equal(partial.episodes.length,6);
});
test('episode variants deduplicate by provider ID and preserve fractional/range labels',()=>{
  const r=p.parseAnime(f.anime(1,{episodes:f.episode(100,'2.5')+f.episode(100,'2.5','4')+f.episode(101,'3-4')}),f.BASE,f.identity(1));
  assert.equal(r.episodes.length,2);assert.equal(r.episodes[0].variants.length,2);assert.equal(r.episodes[1].number,'3-4');
  assert.throws(()=>p.parseAnime(f.anime(1,{episodes:f.episode(100,'1')+f.episode(100,'2')}),f.BASE,f.identity(1)),/Conflicting/);
});
test('wrong identities, challenge pages and truncated episode markup are rejected',()=>{
  assert.throws(()=>p.parseAnime('<html>Challenge</html>',f.BASE,f.identity(1)),/Invalid/);
  assert.throws(()=>p.parseAnime(f.anime(2),f.BASE,f.identity(1)),/identity/);
  assert.throws(()=>p.parseAnime(f.anime(1,{episodes:''}),f.BASE,f.identity(1)),/Episode list/);
  assert.throws(()=>p.parseAnime(f.anime(1,{episodes:'<div class="widget servers"><ul class="episodes"></ul></div>'}),f.BASE,f.identity(1)),/Episode list/);
  assert.throws(()=>p.parseTooltip(f.tooltip(2),f.BASE,f.identity(1)),/identity/);
});
test('changing provider and image origins does not change stored content hashes',()=>{
  const before={},after={};const html=f.anime();
  const a=p.parseAnime(html,f.BASE,f.identity(1),before);
  const b=p.parseAnime(html.replaceAll('animeworld.ac','animeworld.example'), 'https://www.animeworld.example',f.identity(1),after);
  assert.equal(hash(a),hash(b));
  assert.equal(u.resolveReference(a.info.poster,after),'https://img.animeworld.example/locandine/1.jpg');
  assert.throws(()=>u.siteOrigin('https://animeworld.ac.evil.example'),/Invalid/);
});
test('archive count, current page and unique IDs must agree',()=>{
  const ids=Array.from({length:25},(_,i)=>i+1);
  assert.equal(p.parseListing(f.listing(ids),f.BASE,{archive:true}).cards.length,25);
  assert.throws(()=>p.parseListing(f.listing(ids.slice(0,24),{total:25}),f.BASE,{archive:true}),/pagination/);
  assert.throws(()=>p.parseListing(f.listing(ids),f.BASE,{archive:true,page:2}),/pagination/);
  assert.throws(()=>p.parseListing(f.listing([...ids.slice(0,24),1]),f.BASE,{archive:true}),/Duplicate/);
});
test('tooltip aliases and homepage banner references are preserved',()=>{
  assert.equal(p.parseTooltip(f.tooltip(1),f.BASE,f.identity(1)).aliases,'Other title 1');
  assert.deepEqual(p.parseHomeImages(f.home,f.BASE)['code-1'],[{kind:'banner',url:{base:'img',path:'/slider/1.jpg'}}]);
});

test('provider soft-404 templates are distinguishable from empty or challenge responses',()=>{
  assert.equal(p.pageUnavailable(f.shell('<title>AnimeWorld - Pagina non trovata</title>')),true);
  assert.equal(p.pageUnavailable(f.anime()),false);
  assert.equal(p.pageUnavailable('<html>Challenge</html>'),false);
  assert.equal(p.tooltipUnavailable('<div class="inner"><div class="title"><h1></h1></div></div><a class="watch-now" href="/play/.">Watch</a>'),true);
  assert.equal(p.tooltipUnavailable(''),false);assert.equal(p.tooltipUnavailable(f.tooltip(1)),false);
});
