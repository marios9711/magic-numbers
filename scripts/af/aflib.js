// API-Football (v3) access for the daily slip (scripts/af/*). The key comes from the GitHub secret
// APIFOOTBALL_KEY and is sent in a header, so it never appears in logs or URLs.
// The scripts write the same files as the Sportmonks ones (data/af/...), so slip.js, notify.js,
// model.js and motivation.js run unchanged with SM_DIR=data/af.
const S = require('../sm/smlib');

const API = 'https://v3.football.api-sports.io';
const KEY = process.env.APIFOOTBALL_KEY;
const MOCK = process.env.AF_MOCK; // test only: path to a module that fakes the API
const GAP_MS = Number(process.env.AF_GAP_MS || 250); // Pro plan: 300 calls a minute

let calls = 0, last = 0, remaining = null;
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const DEAD = /^(PST|CANC|ABD|AWD|WO)$/;

async function get(endpoint, params = {}) {
  if (MOCK) { calls++; return require(MOCK).get(endpoint, params); }
  const q = new URLSearchParams(params).toString();
  const url = `${API}${endpoint}${q ? '?' + q : ''}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await S.sleep(wait);
    last = Date.now();
    let res;
    try { res = await fetch(url, { headers: { 'x-apisports-key': KEY } }); }
    catch (e) { if (attempt === 3) throw e; await S.sleep(3000 * (attempt + 1)); continue; }
    calls++;
    const rem = Number(res.headers.get('x-ratelimit-requests-remaining'));
    if (Number.isFinite(rem)) remaining = rem;
    if (res.status === 429 || res.status >= 500) { await S.sleep(5000 * (attempt + 1)); continue; }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error(`HTTP ${res.status} for ${endpoint}`);
    const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    if (errs && errs.length) {
      const msg = errs.join('; ');
      if (/too many requests|rate ?limit/i.test(msg) && attempt < 3) { await S.sleep(8000); continue; }
      const err = new Error(`API-Football: ${msg} (${endpoint})`);
      if (/request limit|reached the limit|suspended/i.test(msg)) err.rateLimited = true;
      throw err;
    }
    return j;
  }
  throw new Error(`gave up on ${endpoint}`);
}

// All pages of a paged endpoint (odds, ...).
async function all(endpoint, params = {}, maxPages = 60) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await get(endpoint, page > 1 ? { ...params, page } : params);
    out.push(...(j.response || []));
    const pg = j.paging;
    if (!pg || !pg.total || pg.current >= pg.total) break;
  }
  return out;
}

// Season id used in the data files: "<league>-<year>" (Sportmonks had one number per season).
const sidOf = (lg, season) => `${lg}-${season}`;

// API-Football fixture -> the compact format of smlib.compactFixture.
// Score = 90 minutes (score.fulltime; for matches still running, goals).
function compactFixture(f) {
  const st = f.fixture.status.short;
  const done = FINISHED.has(st);
  const ft = f.score && f.score.fulltime, ht = f.score && f.score.halftime;
  const hg = ft && ft.home != null ? ft.home : f.goals.home, ag = ft && ft.away != null ? ft.away : f.goals.away;
  return {
    id: f.fixture.id, lg: f.league.id, sid: sidOf(f.league.id, f.league.season),
    ts: f.fixture.timestamp, st: done ? (st === 'PEN' ? 'FT_PEN' : st) : st,
    h: f.teams.home.id, a: f.teams.away.id, hn: f.teams.home.name, an: f.teams.away.name,
    hg: done ? hg : null, ag: done ? ag : null,
    hth: done && ht ? ht.home : null, hta: done && ht ? ht.away : null,
    odds: null,
  };
}

// Leagues kept out of the slip: friendlies, youth, women, reserves (thin markets, odd prices).
const SKIP_LEAGUE = /friendl|u1[5-9]|u2[0-3]|youth|junior|women|femen|feminin|frauen|reserve|primavera|\bii\b|\bb team\b/i;

module.exports = { get, all, sidOf, compactFixture, SKIP_LEAGUE, FINISHED, DEAD, callCount: () => calls, remaining: () => remaining };
