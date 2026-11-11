'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {normalize}=require('../sqlite/normalize'),{exportRows}=require('../sqlite/export');
const {publish}=require('../scripts/catalog'),{read,write}=require('../../shared/storage/json');
const origins={'streamingunity:images':'https://cdn.example.invalid'};
function record(){
  const rawThumbnail={base:'streamingunity:images',path:'/wrong.webp'};
  const thumbnail='https://image.tmdb.org/t/p/original/correct.jpg';
  const episode={number:1,title:'Corrected',thumbnail,metadataSources:{
    'streamingunity:1':{thumbnail:rawThumbnail},verifiedOverride:{title:'Corrected',synopsis:'Correct',thumbnail}}};
  return {
    id:'work-1',active:true,sourceIds:{tmdb:'10'},info:{title:'Città di prova',type:'tv'},
    images:[{provider:'streamingunity',type:'poster',lang:'it',reference:{base:'streamingunity:images',path:'/poster.webp'}},
      {provider:'streamingunity',type:'cover_mobile',lang:null,reference:{base:'streamingunity:images',path:'/cover.webp'}}],
    providers:{streamingunity:[{id:1,path:'/it/titles/1-show',availability:'present',info:{},
      seasons:[{number:0,episodes:[{number:1,name:'Original',images:[{type:'cover',reference:rawThumbnail}]}]}]}]},
    seasons:[{number:0,episodes:[episode]}],provenance:{'0:1:thumbnail':'verified-override'},
    artworkLibrary:{tmdb:{originalLanguage:'en-US',
      series:{poster:{it:{status:'available',candidates:[{url:'https://image.tmdb.org/t/p/original/poster.jpg',language:'it'}]}}},
      seasons:{0:{images:{poster:{en:{selected:{url:'https://image.tmdb.org/t/p/original/season.jpg',language:'en'}}}}}}
    }}
  };
}
function tmp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const python=process.env.PYTHON||'python';
function py(args){const r=spawnSync(python,['-B',...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr+'\n'+r.stdout);return r.stdout;}
const script=path.resolve(__dirname,'../sqlite/database.py');
function snapshot(dir,r){publish(dir,[r],{origins,snapshots:{streamingunity:{complete:true}},selectedProviders:['streamingunity']},{nextId:2,members:{'streamingunity:1':'work-1'}},[],{},{pendingCount:0});}
function build(dir,source,previous){exportRows(source,dir);write(path.join(dir,'input.json'),{sourceCommit:'a'.repeat(40),exporterCommit:'b'.repeat(40),complete:true,origins:read(path.join(source,'manifest.json')).origins,expectedCount:1,expectedActiveCount:1});py([script,'build',dir,...(previous?[previous]:[])]);return read(path.join(dir,'manifest.json'));}
test('all artwork URLs retained; overrides forbid wrong thumbnails even with provider-first preferences',()=>{
  const r=record(),rows=normalize(r,origins),images=rows.filter(r=>r.kind==='artwork').map(r=>r.payload.url);
  assert(images.some(v=>v.endsWith('/wrong.webp')));assert(images.some(v=>v.endsWith('/cover.webp')));
  const candidates=rows.filter(r=>r.kind==='artwork_assignment'&&r.payload.scope==='episode'&&r.payload.eligible);
  assert.equal(candidates.length,1);assert.equal(candidates[0].payload.forced,true);assert.equal(candidates[0].payload.source,'tmdb');
  r.seasons[0].episodes[0].metadataSources.verifiedOverride.thumbnail=null;
  assert.equal(normalize(r,origins).filter(r=>r.kind==='artwork_assignment'&&r.payload.scope==='episode'&&r.payload.eligible).length,0);
});
test('edition policies exclude external artwork while preserving URLs and season zero',()=>{
  const r=record();r.metadataPolicy={providerArtworkOnly:true};const rows=normalize(r,origins);
  assert(rows.some(r=>r.kind==='season'&&r.payload.number===0));
  assert(!rows.some(r=>r.kind==='artwork_assignment'&&r.payload.source==='tmdb'&&r.payload.eligible));
  assert(rows.some(r=>r.kind==='artwork'&&r.payload.url.includes('image.tmdb.org')));
});
test('legacy TMDB candidates inherit their language slot; TVDB does not acquire an invented language',()=>{
  const r=record();delete r.artworkLibrary.tmdb.series.poster.it.candidates[0].language;
  r.artworkLibrary.tvdb={series:{poster:'https://artworks.thetvdb.com/banners/example.jpg'}};
  const choices=normalize(r,origins).filter(v=>v.kind==='artwork_assignment'&&v.payload.eligible&&v.payload.scope==='work'&&v.payload.field==='poster');
  assert(choices.some(v=>v.payload.source==='tmdb'&&v.payload.language==='it'));
  assert(choices.some(v=>v.payload.source==='tvdb'&&v.payload.language===null));
});
test('JSON-LD schema image and unclassified image objects remain indexed but cannot become fallback choices',()=>{
  const r=record();r.externalMedia={tmdb:{schema:{image:'https://image.tmdb.org/t/p/w500/schema.jpg'},extra:{url:'https://cdn.example.invalid/orphan.webp'},otherSchema:{image:'https://cdn.example.invalid/image?id=1'}}};
  const rows=normalize(r,origins);
  const {verifyImageCoverage}=require('../sqlite/export');verifyImageCoverage(r,origins,rows);
  assert.throws(()=>verifyImageCoverage(r,origins,rows.filter(v=>v.kind!=='artwork')),/Unindexed/);
  for(const name of ['/schema.jpg','/orphan.webp','/image?id=1']){
    const art=rows.find(v=>v.kind==='artwork'&&v.payload.url.endsWith(name));assert(art);
    assert(rows.filter(v=>v.artworkId===art.id).every(v=>!v.payload.eligible));
  }
});
test('composed work and scoped TMDB identities cannot select artwork of the wrong container',()=>{
  const r=record();r.metadataPolicy={catalog:{kind:'seasons'}};
  assert(!normalize(r,origins).some(v=>v.kind==='artwork_assignment'&&v.payload.source==='streamingunity'&&v.payload.scope==='work'&&v.payload.eligible));
  r.metadataPolicy={tmdb:{scope:'season-compilation',season:0}};
  const rows=normalize(r,origins),candidates=rows.filter(v=>v.kind==='artwork_assignment'&&v.payload.source==='tmdb'&&v.payload.scope==='work'&&v.payload.eligible);
  assert.equal(candidates.length,1);const image=rows.find(v=>v.id===candidates[0].artworkId);assert(image.payload.url.endsWith('/season.jpg'));
});
test('conflicting episode metadata is retained but cannot enter selectable thumbnail fallbacks',()=>{
  const r=record(),ep=r.seasons[0].episodes[0];delete ep.metadataSources.verifiedOverride;
  ep.metadataSources['streamingunity:2']={thumbnail:'https://cdn.example.invalid/conflict.webp'};
  r.warnings=[{source:'streamingunity:2',season:0,episode:1,reason:'episode-title-conflict'}];
  const rows=normalize(r,origins),art=rows.find(v=>v.kind==='artwork'&&v.payload.url.endsWith('/conflict.webp'));
  assert(art);assert(rows.filter(v=>v.artworkId===art.id).every(v=>!v.payload.eligible));
});
test('SQLite FTS, stable generation and logical delta replay including deleted image rows',t=>{
  const root=tmp(t),source=path.join(root,'source'),r=record();snapshot(source,r);
  const a=path.join(root,'a'),b=path.join(root,'b'),again=path.join(root,'again');const first=build(a,source),same=build(again,source);
  assert.equal(first.revision,same.revision);assert.equal(first.snapshot.sha256,same.snapshot.sha256);
  r.seasons[0].episodes[0].title='Nuovo titolo';r.images.pop();snapshot(source,r);
  const second=build(b,source,path.join(a,'cinema.sqlite'));assert.notEqual(first.revision,second.revision);assert.equal(second.deltas[0].fromRevision,first.revision);
  const results=py(['-c',"import sqlite3,sys,json; d=sqlite3.connect(sys.argv[1]); print(json.dumps(d.execute(\"SELECT id FROM search WHERE search MATCH 'citta'\").fetchall()))",path.join(b,'cinema.sqlite')]);assert.deepEqual(JSON.parse(results),[['cinema:work-1']]);
  const failure=spawnSync(python,['-B',script,'apply',path.join(b,'cinema.sqlite'),path.join(b,'delta.ndjson.gz'),path.join(root,'wrong-base.sqlite')],{encoding:'utf8'});
  assert.notEqual(failure.status,0);assert(!fs.existsSync(path.join(root,'wrong-base.sqlite')));
  const gzip=require('node:zlib'),lines=gzip.gunzipSync(fs.readFileSync(path.join(b,'delta.ndjson.gz'))).toString().trim().split('\n').map(JSON.parse);
  assert(lines.some(l=>l.delete));assert(!lines.some(l=>l.upsert?.[1]==='source_episode'));
  const corrupt=path.join(root,'corrupt.gz');lines.find(l=>l.upsert).upsert[5]='{}';fs.writeFileSync(corrupt,gzip.gzipSync(lines.map(JSON.stringify).join('\n')+'\n'));
  const bad=spawnSync(python,['-B',script,'apply',path.join(a,'cinema.sqlite'),corrupt,path.join(root,'corrupt.sqlite')],{encoding:'utf8'});assert.notEqual(bad.status,0);assert(!fs.existsSync(path.join(root,'corrupt.sqlite')));
  const disposable=path.join(root,'disposable.sqlite'),consumed=path.join(root,'consumed.sqlite');fs.copyFileSync(path.join(a,'cinema.sqlite'),disposable);
  py(['-c',"import sys; sys.path.insert(0,sys.argv[1]); from database import apply_delta; apply_delta(sys.argv[2],sys.argv[3],sys.argv[4],consume_base=True)",path.dirname(script),disposable,path.join(b,'delta.ndjson.gz'),consumed]);
  assert(!fs.existsSync(disposable));assert(fs.existsSync(consumed));assert(fs.existsSync(path.join(a,'cinema.sqlite')));
});
test('incomplete or corrupt snapshots cannot produce a publishable export',t=>{
  const root=tmp(t),source=path.join(root,'source');snapshot(source,record());const m=read(path.join(source,'manifest.json'));m.complete=false;write(path.join(source,'manifest.json'),m);
  assert.throws(()=>exportRows(source,path.join(root,'out')),/incomplete/);
  m.complete=true;write(path.join(source,'manifest.json'),m);write(path.join(source,'items/work-1.json'),{});assert.throws(()=>exportRows(source,path.join(root,'out')),/Invalid/);
});
test('a provider origin change creates a new revision even when every stored record and image URL is unchanged',t=>{
  const root=tmp(t),source=path.join(root,'source');snapshot(source,record());
  const first=build(path.join(root,'a'),source),m=read(path.join(source,'manifest.json'));
  m.origins['streamingunity:site']='https://streamingunity.example';write(path.join(source,'manifest.json'),m);
  const next=build(path.join(root,'b'),source,path.join(root,'a/cinema.sqlite'));
  assert.notEqual(first.revision,next.revision);assert.equal(next.origins['streamingunity:site'],'https://streamingunity.example');
});
