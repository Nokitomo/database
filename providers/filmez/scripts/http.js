'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const {setTimeout: sleep} = require('node:timers/promises');
const {assertWarp} = require('../../../shared/warp/guard');
const {siteOrigin,allowedOrigin} = require('./urls');

const PASTEBIN = 'https://pastebin.com/raw/KgQ4jTy6';
const FALLBACK = 'https://filmez.club';

class Client {
  constructor({transport = axios, delay = 600, wait = sleep, guard = assertWarp, signal} = {}) {
    Object.assign(this, {transport, delay, wait, guard, signal});
    this.nextAt = 0;
    this.cookies = new Map();
    this.csrf = new Map();
    this.requests = 0;
  }
  remember(response, url) {
    const host = url.hostname;
    const jar = this.cookies.get(host) || new Map();
    for (const cookie of response.headers?.['set-cookie'] || []) {
      const parts = cookie.split(';').map(part => part.trim());
      const separator = parts[0].indexOf('=');
      if (separator < 1) continue;
      const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1);
      const path = parts.find(part => /^path=/i.test(part))?.slice(5) || '/';
      const expires = parts.find(part => /^expires=/i.test(part))?.slice(8);
      const maxAge = parts.find(part => /^max-age=/i.test(part))?.slice(8);
      const expiry = maxAge !== undefined ? Date.now() + Number(maxAge) * 1000 :
        expires ? Date.parse(expires) : Infinity;
      jar.set(`${path}:${name}`, {name, value, path, expiry});
    }
    this.cookies.set(host, jar);
    if (typeof response.data === 'string' && response.data.includes('csrf-token')) {
      const token = cheerio.load(response.data)('meta[name="csrf-token"]').attr('content');
      if (token) this.csrf.set(host, token);
    }
  }
  async get(value, json = false) {
    let url = new URL(value, this.baseUrl);
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (url.href !== PASTEBIN) allowedOrigin(url.origin);
          this.signal?.throwIfAborted();
          const wait = Math.max(0, this.nextAt - Date.now());
          if (wait) await this.wait(wait, undefined, {signal: this.signal});
          this.guard();
          this.nextAt = Date.now() + this.delay;
          const cookie = [...(this.cookies.get(url.hostname)?.values() || [])]
            .filter(item => item.expiry > Date.now() && (url.pathname === item.path ||
              url.pathname.startsWith(item.path.endsWith('/') ? item.path : item.path + '/')))
            .map(item => `${item.name}=${item.value}`).join('; ');
          const headers = {'User-Agent': 'Mozilla/5.0 (compatible; VegaFilmezDatabase/1.0)',
            Accept: json ? 'application/json' : 'text/html, text/plain;q=0.9', ...(json ? {'X-Requested-With':'XMLHttpRequest'} : {}), ...(cookie ? {Cookie: cookie} : {})};
          const csrf = this.csrf.get(url.hostname);
          if (csrf) headers['CSRF-Token'] = csrf;
          this.requests++;
          const response = await this.transport({method: 'get', url: url.href, headers,
            signal: this.signal, timeout: 25000, maxRedirects: 0, maxContentLength: 16 * 1024 * 1024,
            proxy: false, validateStatus: () => true, responseType: 'text'});
          this.remember(response, url);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.headers.location || redirects === 5) throw new Error('Invalid redirect chain');
            url = new URL(response.headers.location, url);
            continue;
          }
          if (response.status >= 400) {
            const error = new Error(`HTTP ${response.status} at ${url.pathname}`);
            error.status = response.status;
            const after = response.headers['retry-after'];
            error.retryMs = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 0;
            throw error;
          }
          if (response.status !== 200 || typeof response.data !== 'string') throw new Error('Unexpected HTTP response');
          if (new URL(value, this.baseUrl).pathname.startsWith('/it/') && !url.pathname.startsWith('/it/')) throw new Error('Unexpected locale redirect');
          return {html: response.data, url: url.href, headers:response.headers};
        }
      } catch (error) {
        last = error;
        this.signal?.throwIfAborted();
        if (/WARP_REQUIRED/.test(error.message) || [400, 401, 403, 404, 410].includes(error.status) ||
            error.retryMs > 60000) throw error;
        if (attempt < 2) await this.wait(Math.max(error.retryMs || 0, 1500 * (attempt + 1)),
          undefined, {signal: this.signal});
      }
    }
    throw last;
  }
  async discover(lastKnown) {
    let euroUrls=[],discoveryError=null,linked=[];
    try {const text=(await this.get(PASTEBIN)).html;euroUrls=[...text.matchAll(/https:\/\/(?:www\.)?eurostreamings\.[a-z]{2,}/gi)].map(m=>m[0]);}catch(e){if(/WARP_REQUIRED/.test(e.message))throw e;discoveryError=e.message;}
    for(const euro of [...new Set([...euroUrls,'https://eurostreamings.reisen'])])try{
      const page=await this.get(euro+'/film/'),$=cheerio.load(page.html);
      $('.entry a[href]').each((_,el)=>{try{linked.push(siteOrigin($(el).attr('href')));}catch{}});
      if(linked.length)break;
    }catch(e){if(/WARP_REQUIRED/.test(e.message))throw e;discoveryError=e.message;}
    const candidates=[...linked,...(lastKnown?[lastKnown]:[]),FALLBACK],errors=[];
    for(const candidate of [...new Set(candidates)])try{
      const page=await this.get(siteOrigin(candidate)+'/movies/');this.baseUrl=siteOrigin(page.url);
      require('./parse').htmlArchive(page.html,this.baseUrl,'movie',1);
      return {baseUrl:this.baseUrl,source:linked.includes(candidate)?'eurostreaming':candidate===lastKnown?'last-known':'fallback',discoveryError};
    }catch(e){if(/WARP_REQUIRED/.test(e.message))throw e;errors.push(e.message);}
    throw Error('Filmez unavailable: '+errors.join('; '));
  }
}
module.exports={Client,PASTEBIN,FALLBACK};
