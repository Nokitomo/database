'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {sourceFingerprint}=require('../scripts/catalog');
const {decision}=require('../scripts/schedule-update');

const source={provider:'streamingunity',count:19270,expectedCount:19270,itemHashes:{1:'a'},origins:{site:'https://example.invalid'},complete:false};
const cinema={selectedProviders:['streamingunity'],pendingCount:0,sources:{streamingunity:{contentHash:sourceFingerprint(source),complete:false}}};

test('scheduled cinema update leaves an active or queued continuation alone',()=>{
  for(const status of ['queued','in_progress','pending','requested','waiting'])
    assert.equal(decision([{status}],{...cinema,pendingCount:100},{streamingunity:source}),'busy');
});
test('scheduled cinema update skips unchanged incomplete source without pending enrichment',()=>{
  assert.equal(decision([],cinema,{streamingunity:source}),'up_to_date');
  assert.equal(decision([],cinema,{streamingunity:{...source,errors:{one:{retryAt:123}}}}),'up_to_date');
});
test('scheduled cinema update resumes enrichment and notices source changes',()=>{
  assert.equal(decision([],{...cinema,pendingCount:100},{streamingunity:source}),'pending_enrichment');
  assert.equal(decision([],cinema,{streamingunity:{...source,complete:true}}),'source_changed');
  assert.equal(decision([],cinema,{streamingunity:{...source,itemHashes:{1:'b'}}}),'source_changed');
  assert.equal(decision([],null,{streamingunity:source}),'missing_database');
});
