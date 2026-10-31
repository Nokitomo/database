'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createTmdbGet, credentialKind, curlTmdbHtml} = require('../scripts/tmdb-http');
test('curl preserves HTTP status independently from its process exit code', () => {
  const {curlResponse} = require('../scripts/tmdb-http');
  assert.deepEqual(curlResponse('<html>ok</html>\n__TMDB_HTTP_STATUS__:200'), {body: '<html>ok</html>', status: 200});
  assert.equal(curlResponse('\n__TMDB_HTTP_STATUS__:404').status, 404);
  assert.equal(curlResponse('\n__TMDB_HTTP_STATUS__:403').status, 403);
  assert.equal(curlResponse().status, 0);
});

test('TMDB web uses curl only after an Axios 403', async () => {
  const calls = [];
  const get = createTmdbGet(async url => {
    calls.push(`axios:${url}`);
    throw {response: {status: 403}};
  }, {fallback: async url => {calls.push(`curl:${url}`); return '<html>The Movie Database</html>';}, log: () => {}});
  const url = 'https://www.themoviedb.org/tv/37854?language=it-IT';
  const response = await get(url, {responseType: 'text'});
  assert.equal(response.status, 200);
  assert.match(response.data, /The Movie Database/);
  assert.deepEqual(calls, [`axios:${url}`, `curl:${url}`]);
});

test('TMDB web success and other hosts keep their existing request path', async () => {
  let fallbacks = 0;
  const get = createTmdbGet(async () => ({status: 200, data: 'normal'}),
    {fallback: async () => {fallbacks++; return 'fallback';}, log: () => {}});
  assert.equal((await get('https://www.themoviedb.org/tv/37854')).data, 'normal');
  assert.equal((await get('https://www.thetvdb.com/')).data, 'normal');
  assert.equal(fallbacks, 0);
});

test('TMDB web does not hide non-403 failures', async () => {
  const failure = {response: {status: 500}};
  const get = createTmdbGet(async () => {throw failure;},
    {fallback: async () => {throw new Error('unexpected fallback');}, log: () => {}});
  await assert.rejects(get('https://www.themoviedb.org/tv/37854'), error => error === failure);
});

test('TMDB API diagnostics contain only safe status and credential category', async () => {
  const previous = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'private-test-credential';
  try {
    const logs = [];
    const get = createTmdbGet(async () => {
      throw {response: {status: 401, data: {status_code: 7}}, code: 'ERR_BAD_REQUEST'};
    }, {log: message => logs.push(message)});
    await assert.rejects(get('https://api.themoviedb.org/3/tv/37854'));
    assert.match(logs.join('\n'), /HTTP 401; tmdb_code=7/);
    assert.match(logs.join('\n'), /authentication=api_key query/);
    assert.doesNotMatch(logs.join('\n'), /private-test-credential/);
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previous;
  }
});

test('curl fallback rejects other hosts before making a request', async () => {
  await assert.rejects(curlTmdbHtml('https://example.com/', {}, () => {}), /only accepts HTTPS TMDB/);
  await assert.rejects(curlTmdbHtml('https://www.themoviedb.org/tv/37854', {},
    () => {throw new Error('WARP disconnected');}), /WARP disconnected/);
  assert.equal(credentialKind('0123456789abcdef0123456789abcdef'), 'v3-key');
  assert.equal(credentialKind('eyJhbGci.eyJzdWI.signature'), 'bearer-token');
});

test('TMDB API diagnostics describe Bearer authentication without exposing the token', async () => {
  const previous = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'eyJhbGci.eyJzdWI.signature';
  try {
    const logs = [];
    const get = createTmdbGet(async () => ({status: 200, data: {id: 37854}}),
      {log: message => logs.push(message)});
    await get('https://api.themoviedb.org/3/tv/37854');
    assert.match(logs.join('\n'), /credential=bearer-token; authentication=bearer header/);
    assert.doesNotMatch(logs.join('\n'), /eyJhbGci/);
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previous;
  }
});
