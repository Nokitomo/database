'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {withRecordDeadline} = require('../scripts/record-deadline');
const {boundedRequestOptions, createContext} = require('../scripts/vega');

test('a record that completes before its deadline keeps its result', async () => {
  const result = await withRecordDeadline('final 1', signal => {
    assert.equal(signal.aborted, false);
    return 'done';
  }, 100);
  assert.equal(result, 'done');
});

test('a slow record is aborted and logged with its stage and ID', async () => {
  let signal;
  await assert.rejects(withRecordDeadline('final 123', current => {
    signal = current;
    return new Promise(() => {});
  }, 5), /final 123: exceeded 1 minute record deadline/);
  assert.equal(signal.aborted, true);
});

test('provider requests inherit the record abort signal and their original timeout cap', async () => {
  const controller = new AbortController();
  let requestOptions;
  const context = createContext('.', 'https://www.animeunity.co', null, {
    signal: controller.signal,
    httpGet: async (_url, options) => {
      requestOptions = options;
      return {data: 'ok'};
    },
  });
  await context.axios.get('https://example.com/', {timeout: 90_000});
  assert.equal(requestOptions.signal, controller.signal);
  assert.equal(requestOptions.timeout, 30_000);
  assert.equal(boundedRequestOptions({timeout: 5000}).timeout, 5000);
  controller.abort();
  await assert.rejects(context.axios.get('https://example.com/'), {name: 'AbortError'});
});
