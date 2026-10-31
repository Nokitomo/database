'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {selectFinalBatch} = require('../scripts/final-queue');
const rows = (count, final) => Array.from({length: count}, (_, id) => ({id, episodes: final ? 1 : 100, final}));
test('initial coverage receives 80 percent even when retries have fewer episodes', () => {
  const selected = selectFinalBatch([...rows(100, null), ...rows(100, {updatedAt: '2026-01-01'})], 50);
  assert.equal(selected.filter(row => !row.final).length, 40);
  assert.equal(selected.filter(row => row.final).length, 10);
});
test('unused capacity is filled, zero and unlimited limits work', () => {
  assert.equal(selectFinalBatch(rows(100, null), 50).length, 50);
  assert.equal(selectFinalBatch(rows(100, {}), 50).length, 50);
  assert.equal(selectFinalBatch([...rows(2, null), ...rows(100, {})], 50).length, 50);
  assert.equal(selectFinalBatch(rows(10, null), 0).length, 0);
  assert.equal(selectFinalBatch(rows(10, null), Infinity).length, 10);
});
test('refreshes rotate by oldest processing time rather than episode count', () => {
  const selected = selectFinalBatch([{id: 1, episodes: 1, final: {updatedAt: '2026-10-31'}},
    {id: 2, episodes: 1000, final: {updatedAt: '2026-10-01'}}], 1);
  assert.equal(selected[0].id, 2);
});
