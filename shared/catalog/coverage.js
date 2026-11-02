'use strict';
// Coverage is an optimization hint, never an authority for provider membership.
const path = require('node:path');
const {read, write, hash} = require('../storage/json');
const DAY = 86400000;
const ANIME = new Set(['animeworld', 'animesaturn', 'animetop']);
const SECONDARY = new Set([...ANIME, 'altadefinizione', 'eurostreaming', 'filmez']);
const positive = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? String(v) : null;
function ids(record, kind) {
  const s = record.sourceIds || {}, i = record.info || {};
  return kind === 'anime' ? {
    anilist: positive(s.anilistId ?? s.anilist ?? i.anilist_id),
    mal: positive(s.malId ?? s.mal ?? i.mal_id),
  } : {tmdb: positive(s.tmdb_id ?? s.tmdb), tvdb: positive(s.tvdb_id ?? s.tvdb),
    imdb: /^tt\d+$/.test(s.imdb_id ?? s.imdb ?? '') ? (s.imdb_id ?? s.imdb) : null};
}
function mediaType(record) {
  const t = String(record.info?.type || '').toLowerCase();
  if (/movie|film/.test(t)) return 'movie';
  if (/special|ova|ona/.test(t)) return t;
  return /tv|series|serie/.test(t) ? 'series' : null;
}
const meaningful = v => typeof v === 'string' && v.trim() && !/^(episode|episodio)\s*[\d.]+$/i.test(v.trim());
function episodeKeys(record,kind){
  const episodes=record.episodes||(record.seasons||[]).flatMap(s=>(s.episodes||[]).map(e=>({...e,seasonNumber:e.seasonNumber??s.number})));
  return episodes.map(e=>{
    const number=kind==='anime'?(e.sourceEpisodeNumber??e.number??e.episodeNumber):(e.number??e.episodeNumber),season=kind==='anime'?1:(e.seasonNumber??e.season??1);
    if(!/^\d+(?:[.,]\d+)?$/.test(String(number))||!/^\d+$/.test(String(season)))return null;
    return Number(season)+':'+Number(String(number).replace(',','.'));
  });
}
function missing(record) {
  const i = record.info || {}, fields = [];
  if (!i.title && !i.name) fields.push('title');
  if (!i.synopsis && !i.plot) fields.push('synopsis');
  if (!i.poster) fields.push('poster');
  if (!i.background) fields.push('background');
  const episodes = record.episodes || (record.seasons || []).flatMap(s => s.episodes || []);
  if (mediaType(record) !== 'movie' && (!episodes.length || episodes.some(e =>
    !meaningful(e.title || e.name) || !(e.synopsis || e.plot) || !(e.thumbnail || e.still)))) fields.push('episodes');
  return fields;
}
function build(records, kind, now = Date.now()) {
  if (!['anime', 'cinema'].includes(kind)) throw Error('Invalid coverage kind');
  const primary = kind === 'anime' ? 'animeunity' : 'streamingunity';
  const entries = records.filter(r => r.active !== false && (r.providers?.[primary] || []).some(v =>
    !v.availability || v.availability === 'present') && (!r.availability || r.availability[primary] === 'present'))
    .map(r => ({id: r.id, ids: ids(r, kind), type: mediaType(r), missing: missing(r),
      episodeCount:(r.episodes||(r.seasons||[]).flatMap(s=>s.episodes||[])).length,
      episodeKeys:episodeKeys(r,kind),
      members: Object.entries(r.providers || {}).flatMap(([provider,variants]) => variants
        .filter(v => SECONDARY.has(provider) && (!v.availability || v.availability === 'present') && (v.info||v.sourceIdentity))
        .map(v => {const info=v.info||v.sourceIdentity;return {provider,id:String(v.id),path:v.path,title:info.title||info.name,
          year:info.year||null,type:mediaType({info})};})),
      ready: r.enrichment?.status === 'ready', fingerprint: hash({ids: ids(r, kind), info: r.info,
        episodes: r.episodes, seasons: r.seasons, enrichment: r.enrichment})}));
  const body = {schemaVersion: 1, kind, primary, generatedAt: now, entries};
  return {...body, contentHash: hash(body)};
}
function publish(root, records, kind, now) {
  const coverage = build(records, kind, now);
  write(path.join(root, 'coverage.json'), coverage);
  return coverage.contentHash;
}
function verifyPublication(root,expected,kind){
  if(!expected)return; // Legacy manifests remain readable during migration.
  const value=read(path.join(root,'coverage.json'));
  if(!value)throw Error('Missing coverage export');
  const {contentHash,...body}=value;
  if(value.kind!==kind||contentHash!==expected||hash(body)!==expected)throw Error('Invalid coverage export');
}
function load(provider, file = process.env.CATALOG_COVERAGE, now = Date.now()) {
  if (!SECONDARY.has(provider) || !file) return null;
  try {
    const value = read(file);
    if (!value) return null;
    const {contentHash, ...body} = value;
    const kind = ANIME.has(provider) ? 'anime' : 'cinema';
    if (value.schemaVersion !== 1 || value.kind !== kind || !Array.isArray(value.entries) ||
      value.primary !== (kind === 'anime' ? 'animeunity' : 'streamingunity') || hash(body) !== contentHash ||
      !Number.isFinite(value.generatedAt) || now < value.generatedAt || now - value.generatedAt > 7 * DAY) return null;
    const lookup = new Map(), membership = new Map(), unique = new Set();
    for (const e of value.entries) {
      if (!e.id || unique.has(e.id) || !e.ids || !Array.isArray(e.missing) || typeof e.ready !== 'boolean') return null;
      unique.add(e.id);
      for(const m of e.members || []){
        const key=m.provider+':'+m.id;
        if(!membership.has(key))membership.set(key,[]);
        membership.get(key).push({entry:e,member:m});
      }
      for (const [key, id] of Object.entries(e.ids)) if (id) {
        const k = key + ':' + id;
        if (!lookup.has(k)) lookup.set(k, []);
        lookup.get(k).push(e);
      }
    }
    return {...value, lookup, membership};
  } catch { return null; } // Corrupt/missing hints must not suppress scraping.
}
function decide(coverage, record) {
  if (!coverage) return {mode: 'full', reason: 'coverage-unavailable'};
  const direct = ids(record, coverage.kind), type = mediaType(record);
  const prior=(coverage.membership?.get(record.provider+':'+record.id)||[]).filter(({member:m})=>
    m.path===record.path && m.title===(record.info?.title||record.info?.name) &&
    m.type===type && (!m.year||!record.info?.year||String(m.year)===String(record.info.year)));
  const matches = [...new Set([...Object.entries(direct).filter(([,id]) => id)
    .flatMap(([key,id]) => coverage.lookup.get(key + ':' + id) || []),...prior.map(p=>p.entry)])];
  if (matches.length !== 1) return {mode: 'full', reason: matches.length ? 'ambiguous-identity' : 'exclusive-or-unresolved'};
  const match = matches[0];
  if ((coverage.kind==='cinema'&&(!type||!match.type)) || (type&&match.type&&type !== match.type) || Object.keys(direct).some(k => direct[k] && match.ids[k] && direct[k] !== match.ids[k]))
    return {mode: 'full', reason: 'conflicting-identity'};
  // Anime presence does not assert episode correspondence or metadata completeness.
  if (coverage.kind === 'anime' && match.ready) return {mode: 'linked', primary: coverage.primary,
    workId: match.id, fingerprint: match.fingerprint, episodeResolution: 'live'};
  if (!match.ready || match.missing.length) return {mode: 'full', reason: 'missing-primary-metadata', fields: match.missing};
  const count=(record.episodes||(record.seasons||[]).flatMap(s=>s.episodes||[])).length;
  const keys=episodeKeys(record,coverage.kind);
  if(count>match.episodeCount||new Set(keys).size!==keys.length||keys.some(k=>k===null||!(match.episodeKeys||[]).includes(k)))return {mode:'full',reason:'additional-provider-episodes'};
  return {mode: 'linked', primary: coverage.primary, workId: match.id, fingerprint: match.fingerprint};
}
function annotate(record, coverage, now, previous) {
  const policy = decide(coverage, record);
  if(coverage || previous?.collection)record.collection = {...policy,
    ...(policy.mode==='linked'?{identityCheckedAt:now}:{})};
  return policy;
}
function reusable(record, known, coverage, now) {
  if (!record || known.refresh || known.forceRefresh || known.missingScans || known.missingScanAt ||
    record.path !== known.path || !record.collection?.identityCheckedAt ||
    now < record.collection.identityCheckedAt ||
    now - record.collection.identityCheckedAt >= 7 * DAY) return false;
  return decide(coverage, record).mode === 'linked';
}
module.exports = {build, publish, verifyPublication, load, decide, annotate, reusable, ids, mediaType, missing, SECONDARY};
