'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {dependencyFingerprint, canAcknowledgeIndex} = require('../scripts/mapping-dependencies');
const {componentDependencies, mappingFingerprint, migrateFinalMapping} = require('../scripts/incremental');

test('index acknowledgement bootstraps only from the same snapshot and respects retry deadlines', () => {
  const raw = {fingerprint: 'raw'}, mapped = {rawFingerprint: 'raw', providerRef: 'v', mappingSourceHash: 'old'};
  assert.equal(canAcknowledgeIndex(mapped, raw, 'v', 'old', 'dep'), true);
  assert.equal(canAcknowledgeIndex(mapped, raw, 'v', 'new', 'dep'), false);
  const migrated = {...mapped, mappingDependencyVersion: 1, mappingDependencyFingerprint: 'dep'};
  assert.equal(canAcknowledgeIndex(migrated, raw, 'v', 'new', 'dep'), true);
  assert.equal(canAcknowledgeIndex(migrated, raw, 'v', 'new', 'different'), false);
  assert.equal(canAcknowledgeIndex({...migrated, mappingPolicy: {nextCheckAt: 0}}, raw, 'v', 'new', 'dep'), false);
});

test('dependency signature observes reverse additions and absent direct entries', () => {
  const raw = {info: {anilist_id: 1}}, index = {schemaVersion: '3', records: new Map()};
  const before = dependencyFingerprint(index, () => [], raw);
  assert.notEqual(dependencyFingerprint(index, () => [{sourceDescriptor:'anilist:1', targets:[{id:'2'}]}], raw), before);
  index.records.set('anilist:1', {targets: [{id:'3'}]});
  assert.notEqual(dependencyFingerprint(index, () => [], raw), before);
});

test('related empty mappings migrate without enrichment; episode ranges and primary IDs do not', () => {
  const direct = {provider:'tmdb_show', id:'10', scope:'s1', ranges:{'1-12':'1-12'}};
  const old = {sourceIds:{anilistId:1}, ids:{tmdbShowIds:[10,20]}, metadataTargets:[direct],
    mappings:{targets:[direct,{provider:'tmdb_show',id:'20'}]}};
  const next = structuredClone(old); next.ids.tmdbShowIds = [10]; next.mappings.targets.pop();
  const final = {info:{title:'Test',extra:{}}, mappingFingerprintVersion:2,mappingFingerprint:mappingFingerprint(old)};
  const migrated = migrateFinalMapping(final,old,next);
  assert.equal(migrated.mappingFingerprint,mappingFingerprint(next));
  assert.deepEqual(migrated.info.extra.ids,next.ids);
  const changed = structuredClone(next); changed.metadataTargets[0].ranges={'1-12':'13-24'};
  assert.notDeepEqual(componentDependencies(next),componentDependencies(changed));
  assert.equal(migrateFinalMapping(final,old,changed).mappingFingerprint,final.mappingFingerprint);
});

test('confirming a movie already typed by the provider does not invalidate metadata', () => {
  const old = {sourceMediaType:'Movie', sourceIds:{anilistId:11981},
    metadataTargets:[{provider:'tmdb_movie',id:'212162',ranges:{1:'1'}}],
    mappings:{targets:[{provider:'tmdb_movie',id:'212162',ranges:{1:'1'}}, {provider:'tmdb_show',id:'39218'}]}};
  const next = structuredClone(old); next.metadataMediaType='movie'; next.mappings.targets.pop();
  assert.deepEqual(componentDependencies(old),componentDependencies(next));
  assert.notDeepEqual(componentDependencies({...old,sourceMediaType:'ONA'}),componentDependencies(next));
});
