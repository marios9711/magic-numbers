// Shared helpers for the Sportmonks scripts (API v3). The token comes from the GitHub secret
// SPORTMONKS_KEY and is sent in the Authorization header, so it never appears in logs or URLs.
// Without the secret every script logs one line and exits cleanly (nothing is written).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data/sm');
const BASE = 'https://api.sportmonks.com/v3';
const KEY = process.env.SPORTMONKS_KEY;
const MOCK = process.env.SM_MOCK; // test only: path to a module that fakes the API

const FINISHED = new Set(['FT', 'AET', 'FT_PEN']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
const p = rel => path.join(DIR, rel);

function needKey(name) {
  if (KEY || MOCK) return true;
  console.log(`${name}: SPORTMONKS_KEY secret is not set — skipping (nothing changed).`);
  return false;
}

// Remaining calls per entity, from each response's rate_limit block.
const limits = {};
let calls = 0;

async function get(endpoint, params = {}) {
  if (MOCK) return require(MOCK).get(endpoint, params, limits);
  const q = new URLSearchParams(params).toString();
  const url = `${BASE}${endpoint}${q ? '?' + q : ''}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: KEY, Accept: 'application/json' } }); }
    catch (e) { if (attempt === 3) throw e; await sleep(3000 * (attempt + 1)); continue; }
    calls++;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Number(body.retry_after || res.headers.get('retry-after') || 0);
      if (wait > 0 && wait <= 90) { await sleep(wait * 1000); continue; }
      const err = new Error(`rate limit reached for ${endpoint}`); err.rateLimited = true; throw err;
    }
    if (res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}: ${JSON.stringify(j && (j.message || j)).slice(0, 200)}`);
    if (j && j.rate_limit) limits[j.rate_limit.requested_entity] = j.rate_limit.remaining;
    return j;
  }
  throw new Error(`gave up on ${endpoint}`);
}

// All pages of a list endpoint (cursor pagination, falling back to page numbers).
async function all(endpoint, params = {}, { maxPages = 200, onPage } = {}) {
  const out = [];
  let cursor = null, page = 1;
  for (let i = 0; i < maxPages; i++) {
    const prm = { per_page: 50, ...params };
    if (cursor) prm.cursor = cursor; else if (page > 1) prm.page = page;
    const j = await get(endpoint, prm);
    const data = j && j.data ? (Array.isArray(j.data) ? j.data : [j.data]) : [];
    out.push(...data);
    if (onPage) onPage(data);
    const pg = j && j.pagination;
    if (!pg || !pg.has_more || !data.length) break;
    if (pg.next_cursor) cursor = pg.next_cursor; else page++;
  }
  return out;
}

// --- fixtures -------------------------------------------------------------------------------
// Compact fixture: { id, lg, sid, ts, st, h, a, hn, an, hg, ag }. Score = 90 minutes
// ("2ND_HALF" is cumulative after 90'; "CURRENT" otherwise).
function compactFixture(f) {
  const parts = f.participants || [];
  const home = parts.find(x => x.meta && x.meta.location === 'home') || parts[0] || {};
  const away = parts.find(x => x.meta && x.meta.location === 'away') || parts[1] || {};
  const st = f.state ? (f.state.developer_name || f.state.state || f.state.short_name) : String(f.state_id || '');
  let hg = null, ag = null;
  const sc = f.scores || [];
  for (const desc of ['2ND_HALF', 'CURRENT']) {
    const rows = sc.filter(s => s.description === desc && s.score);
    const h = rows.find(s => s.score.participant === 'home'), a = rows.find(s => s.score.participant === 'away');
    if (h && a) { hg = h.score.goals; ag = a.score.goals; break; }
  }
  return {
    id: f.id, lg: f.league_id, sid: f.season_id,
    ts: f.starting_at_timestamp || Math.floor(Date.parse((f.starting_at || '').replace(' ', 'T') + 'Z') / 1000),
    st, h: home.id, a: away.id, hn: home.name, an: away.name,
    hg: FINISHED.has(st) ? hg : null, ag: FINISHED.has(st) ? ag : null,
    odds: f.has_odds == null ? null : !!f.has_odds,
  };
}

// Season files hold finished matches as rows [id, ts, homeId, awayId, hg, ag].
function addResults(fixtures, state) {
  const bySeason = {};
  for (const f of fixtures) {
    if (f.hg == null || f.ag == null || !f.h || !f.a || !f.sid) continue;
    (bySeason[f.sid] = bySeason[f.sid] || []).push(f);
  }
  const teams = readJSON(p('teams.json'), {});
  let added = 0;
  for (const [sid, list] of Object.entries(bySeason)) {
    const file = p(`seasons/${sid}.json`);
    const s = readJSON(file, { sid: Number(sid), lg: list[0].lg, m: [] });
    const have = new Map(s.m.map((r, i) => [r[0], i]));
    for (const f of list) {
      const row = [f.id, f.ts, f.h, f.a, f.hg, f.ag];
      if (have.has(f.id)) s.m[have.get(f.id)] = row; else { s.m.push(row); added++; }
      if (f.hn) teams[f.h] = f.hn; if (f.an) teams[f.a] = f.an;
    }
    s.m.sort((x, y) => x[1] - y[1]);
    writeJSON(file, s);
    if (state) state.seasonLeague[sid] = s.lg;
  }
  writeJSON(p('teams.json'), teams);
  return added;
}

// --- odds -----------------------------------------------------------------------------------
// Margin removal, power method: raise each implied chance 1/odds to the same power k so they add to 1.
function powerFair(prices) {
  if (!prices.every(x => x > 1)) return null;
  const q = prices.map(x => 1 / x), sum = k => q.reduce((s, v) => s + v ** k, 0);
  if (sum(1) < 1) { const s = sum(1); return q.map(v => v / s); } // no margin (exchange): scale up
  let lo = 0.3, hi = 4;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (sum(mid) > 1) lo = mid; else hi = mid; }
  const k = (lo + hi) / 2;
  return q.map(v => v ** k);
}

const num = s => {
  if (s == null || s === '') return null;
  const parts = String(s).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null; // "2, 2.5" -> 2.25
};
const fmtLine = x => (x > 0 ? '+' : '') + (Math.round(x * 100) / 100);

// One Sportmonks odd row -> { key, group } or null.
//   1X2: '1','X','2'   DC: 'DC1X','DC12','DCX2'   BTTS: 'BY','BN'
//   Goals: 'O2.5','U2.5' (any line)   Asian handicap: 'AHH-0.5' / 'AHA+0.5' (line from that side's view)
function keyOf(o, mk, homeName, awayName) {
  const lab = String(o.label || o.name || '').trim(), L = lab.toLowerCase();
  const isHome = L === '1' || L === 'home' || (homeName && L === homeName.toLowerCase());
  const isAway = L === '2' || L === 'away' || (awayName && L === awayName.toLowerCase());
  if (mk === '1X2') {
    const k = isHome ? '1' : isAway ? '2' : (L === 'x' || L === 'draw') ? 'X' : null;
    return k && { key: k, group: '1X2' };
  }
  if (mk === 'DC') {
    const m = { '1x': 'DC1X', 'home/draw': 'DC1X', '12': 'DC12', 'home/away': 'DC12', 'x2': 'DCX2', 'draw/away': 'DCX2' }[L];
    return m && { key: m, group: 'DC' };
  }
  if (mk === 'BTTS') {
    const k = L === 'yes' ? 'BY' : L === 'no' ? 'BN' : null;
    return k && { key: k, group: 'BTTS' };
  }
  if (mk === 'OU') {
    const t = num(o.total != null ? o.total : o.name);
    if (t == null || t < 0.5 || t > 5.5 || (t * 4) % 1 !== 0) return null;
    const k = L.startsWith('over') ? 'O' : L.startsWith('under') ? 'U' : null;
    return k && { key: `${k}${t}`, group: `OU${t}` };
  }
  if (mk === 'AH') {
    const h = num(o.handicap != null ? o.handicap : o.name);
    if (h == null || Math.abs(h) > 3 || (h * 4) % 1 !== 0) return null;
    if (isHome) return { key: `AHH${fmtLine(h)}`, group: `AH${fmtLine(h)}`, side: 'H', line: h };
    if (isAway) return { key: `AHA${fmtLine(h)}`, group: null, side: 'A', line: h }; // group set later
    return null;
  }
  return null;
}

// Outcome of a selection for a final score: 1 win, 0.5 half win, 0 push, -0.5 half loss, -1 loss.
function settle(key, hg, ag) {
  const sgn = d => (d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0);
  const line = (diff, t) => { // diff(t) = margin over line t; quarter lines split the stake
    if (Math.abs((t * 4) % 2) === 1) return (sgn(diff(t - 0.25)) + sgn(diff(t + 0.25))) / 2;
    return sgn(diff(t));
  };
  const T = hg + ag;
  switch (key) {
    case '1': return hg > ag ? 1 : -1;
    case 'X': return hg === ag ? 1 : -1;
    case '2': return ag > hg ? 1 : -1;
    case 'DC1X': return hg >= ag ? 1 : -1;
    case 'DC12': return hg !== ag ? 1 : -1;
    case 'DCX2': return ag >= hg ? 1 : -1;
    case 'BY': return hg > 0 && ag > 0 ? 1 : -1;
    case 'BN': return hg > 0 && ag > 0 ? -1 : 1;
  }
  let m;
  if ((m = /^O(-?[\d.]+)$/.exec(key))) return line(t => T - t, Number(m[1]));
  if ((m = /^U(-?[\d.]+)$/.exec(key))) return line(t => t - T, Number(m[1]));
  if ((m = /^AHH([+-]?[\d.]+)$/.exec(key))) return line(t => hg - ag + t, Number(m[1]));
  if ((m = /^AHA([+-]?[\d.]+)$/.exec(key))) return line(t => ag - hg + t, Number(m[1]));
  return null;
}
// Profit for a 1-unit stake at decimal odds P.
const payoff = (r, P) => (r > 0 ? r * (P - 1) : r);

const marketOf = key => key === '1' || key === 'X' || key === '2' ? '1X2' : key.startsWith('DC') ? 'DC'
  : key === 'BY' || key === 'BN' ? 'BTTS' : key.startsWith('AH') ? 'AH' : 'OU';

function label(key, hn, an) {
  if (key === '1') return `${hn} to win`;
  if (key === '2') return `${an} to win`;
  if (key === 'X') return 'Draw';
  if (key === 'DC1X') return `${hn} or draw`;
  if (key === 'DCX2') return `${an} or draw`;
  if (key === 'DC12') return 'No draw';
  if (key === 'BY') return 'Both teams score';
  if (key === 'BN') return 'Not both teams score';
  let m;
  if ((m = /^O(.+)$/.exec(key))) return `Over ${m[1]} goals`;
  if ((m = /^U(.+)$/.exec(key))) return `Under ${m[1]} goals`;
  if ((m = /^AHH(.+)$/.exec(key))) return `${hn} ${m[1]} (Asian)`;
  if ((m = /^AHA(.+)$/.exec(key))) return `${an} ${m[1]} (Asian)`;
  return key;
}

const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);

function loadState() {
  const s = readJSON(p('state.json'), {});
  s.leagues = s.leagues || {};      // id -> { name, country, seasons: [ids] }
  s.seasonLeague = s.seasonLeague || {};
  s.hist = s.hist || {};            // seasonId -> { done, n }
  s.books = s.books || {};          // id -> name
  s.markets = s.markets || null;    // { '1X2': id, ... }
  s.log = s.log || [];
  return s;
}
function saveState(s, entry) {
  if (entry) { s.log.unshift({ t: new Date(Date.now()).toISOString(), calls, limits: { ...limits }, ...entry }); s.log = s.log.slice(0, 60); }
  writeJSON(p('state.json'), s);
}

module.exports = {
  ROOT, DIR, p, readJSON, writeJSON, needKey, get, all, limits, callCount: () => calls,
  compactFixture, addResults, powerFair, keyOf, settle, payoff, marketOf, label, num, fmtLine,
  day, now, sleep, loadState, saveState, FINISHED,
};
