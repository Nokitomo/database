'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MIN_GAP_MS, MAX_RETRY_WAIT_MS, createPacedGet, retryAfterMs} = require('../scripts/rate-limit');

test('TMDB API pacing stays below documented bulk threshold', () => {
  assert.ok(MIN_GAP_MS['api.themoviedb.org'] >= 250);
  assert.equal(retryAfterMs('2', 1000), 2000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
});

test('TMDB 429 waits for Retry-After and retries without exposing the key', async () => {
  let clock = 1000;
  const calls = [];
  let checks = 0;
  const paced = createPacedGet(async url => {
    calls.push({url, at: clock});
    if (calls.length === 1) throw {response: {status: 429, headers: {'retry-after': '2'}}};
    return {data: {ok: true}};
  }, {now: () => clock, sleep: async ms => {clock += ms;}, check: () => {checks++;}});
  const response = await paced('https://api.themoviedb.org/3/tv/1', {params: {api_key: 'test'}});
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 2000);
  assert.equal(checks, 2);
});

test('sequential TMDB requests reserve separate rate-limit slots', async () => {
  let clock = 1000;
  const starts = [];
  const paced = createPacedGet(async () => {starts.push(clock); return {data: {}};},
    {now: () => clock, sleep: async ms => {clock += ms;}});
  await paced('https://api.themoviedb.org/3/tv/1');
  await paced('https://api.themoviedb.org/3/tv/2');
  assert.deepEqual(starts, [1000, 1250]);
});

test('an excessive Retry-After fails promptly instead of blocking a job', async () => {
  let waits = 0;
  const paced = createPacedGet(async () => {
    throw {response: {status: 429, headers: {'retry-after': String(MAX_RETRY_WAIT_MS / 1000 + 1)}}};
  }, {now: () => 1000, sleep: async () => {waits++;}});
  await assert.rejects(paced('https://api.themoviedb.org/3/tv/1'), error =>
    error.retryAfterMs === MAX_RETRY_WAIT_MS + 1000);
  assert.equal(waits, 0);
});
