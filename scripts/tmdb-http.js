'use strict';

const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {assertWarp} = require('./warp');

const runFile = promisify(execFile);
const reported = new Set();

function credentialKind(value) {
  const key = String(value || '').trim();
  if (!key) return 'missing';
  if (/^[a-f0-9]{32}$/i.test(key)) return 'v3-key';
  if (/^(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\./i.test(key)) return 'bearer-token';
  return 'other';
}

function authenticationMethod(value) {
  return credentialKind(value) === 'bearer-token' ? 'bearer header' : 'api_key query';
}

function reportOnce(key, message, log = console.error) {
  if (reported.has(key)) return;
  reported.add(key);
  log(message);
}

async function curlTmdbHtml(url, _options = {}, check = assertWarp) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.themoviedb.org')
    throw new Error('TMDB web fallback only accepts HTTPS TMDB pages');
  const args = ['--silent', '--show-error', '--location', '--fail', '--compressed',
    '--proto', '=https', '--proto-redir', '=https', '--max-time', '15',
    url];
  check();
  try {
    const {stdout} = await runFile(process.platform === 'win32' ? 'curl.exe' : 'curl', args,
      {encoding: 'utf8', timeout: 20000, maxBuffer: 20 * 1024 * 1024, windowsHide: true});
    if (!stdout || /<title>\s*Just a moment/i.test(stdout))
      throw new Error('TMDB web fallback returned an empty or blocked page');
    return stdout;
  } finally {
    check();
  }
}

function createTmdbGet(get, {fallback = curlTmdbHtml, log = console.error} = {}) {
  return async (url, options) => {
    const host = new URL(url).hostname.toLowerCase();
    try {
      const response = await get(url, options);
      if (host === 'api.themoviedb.org') {
        reportOnce('api-success', `[tmdb-api] HTTP ${response.status}; credential=${credentialKind(process.env.TMDB_API_KEY)}; authentication=${authenticationMethod(process.env.TMDB_API_KEY)}`, log);
      }
      return response;
    } catch (error) {
      if (host === 'api.themoviedb.org') {
        const status = Number(error?.response?.status) || 0;
        const tmdbCode = Number(error?.response?.data?.status_code) || 0;
        const code = /^[A-Z_0-9]+$/.test(String(error?.code || '')) ? error.code : 'unknown';
        reportOnce(`api-${status}-${tmdbCode}-${code}`,
          `[tmdb-api] HTTP ${status || 'none'}; tmdb_code=${tmdbCode || 'none'}; network_code=${code}; credential=${credentialKind(process.env.TMDB_API_KEY)}; authentication=${authenticationMethod(process.env.TMDB_API_KEY)}`, log);
      }
      if (host !== 'www.themoviedb.org' || Number(error?.response?.status) !== 403) throw error;
      try {
        const html = await fallback(url, options);
        reportOnce('web-curl-success', '[tmdb-web] Axios HTTP 403; curl fallback succeeded', log);
        return {data: html, status: 200};
      } catch (fallbackError) {
        reportOnce('web-curl-failure', `[tmdb-web] Axios HTTP 403; curl fallback failed (code=${String(fallbackError?.code || 'unknown').replace(/[^A-Z0-9_]/gi, '')})`, log);
        throw fallbackError;
      }
    }
  };
}

module.exports = {createTmdbGet, credentialKind, curlTmdbHtml};
