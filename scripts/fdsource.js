// Backup source loader: turns football-data.co.uk files (data/fdco/, written by fdco.js) into the
// same compact rows and odds the build uses for API-Football data.
//   rows: { id, ts, st, lg, ln, lc, h, hn, a, an, hg, ag }
//   odds: id -> { m: Bet365 (latest: closing if known), open: Bet365 pre-match, best: market max, avg: market average }
// Kick-off times in these files are UK time.
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON } = require('./lib');

// football-data code -> [API-Football league id (so league history from data/seasons can be used), country, league]
const LEAGUES = {
  E0: [39, 'England', 'Premier League'], E1: [40, 'England', 'Championship'], E2: [41, 'England', 'League One'],
  E3: [9001, 'England', 'League Two'], EC: [9002, 'England', 'National League'],
  SC0: [179, 'Scotland', 'Premiership'], SC1: [9003, 'Scotland', 'Championship'], SC2: [9004, 'Scotland', 'League One'], SC3: [9005, 'Scotland', 'League Two'],
  D1: [78, 'Germany', 'Bundesliga'], D2: [79, 'Germany', '2. Bundesliga'], I1: [135, 'Italy', 'Serie A'], I2: [136, 'Italy', 'Serie B'],
  SP1: [140, 'Spain', 'La Liga'], SP2: [141, 'Spain', 'Segunda División'], F1: [61, 'France', 'Ligue 1'], F2: [62, 'France', 'Ligue 2'],
  N1: [88, 'Netherlands', 'Eredivisie'], B1: [144, 'Belgium', 'Jupiler Pro League'], P1: [94, 'Portugal', 'Primeira Liga'],
  T1: [203, 'Turkey', 'Süper Lig'], G1: [197, 'Greece', 'Super League 1'],
  ARG: [128, 'Argentina', 'Liga Profesional'], AUT: [218, 'Austria', 'Bundesliga'], BRA: [71, 'Brazil', 'Serie A'], CHN: [9006, 'China', 'Super League'],
  DNK: [119, 'Denmark', 'Superliga'], FIN: [9007, 'Finland', 'Veikkausliiga'], IRL: [9008, 'Ireland', 'Premier Division'], JPN: [98, 'Japan', 'J1 League'],
  MEX: [262, 'Mexico', 'Liga MX'], NOR: [103, 'Norway', 'Eliteserien'], POL: [106, 'Poland', 'Ekstraklasa'], ROU: [283, 'Romania', 'Liga I'],
  RUS: [235, 'Russia', 'Premier League'], SWE: [113, 'Sweden', 'Allsvenskan'], SWZ: [207, 'Switzerland', 'Super League'], USA: [253, 'USA', 'MLS'],
};
const BY_COUNTRY = Object.fromEntries(Object.entries(LEAGUES).filter(([k]) => k.length === 3 && !/\d/.test(k)).map(([k, v]) => [v[1], k]));

const hash = s => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return 900000000 + (h % 99999999); };
const num = v => { const n = Number(v); return n > 1 ? n : null; };
function londonTs(date, time) {
  const [d, m, y] = date.split('/').map(Number), [hh, mm] = (time || '15:00').split(':').map(Number);
  const yr = y < 100 ? 2000 + y : y, guess = Date.UTC(yr, m - 1, d, hh, mm);
  // UK offset at that moment (0 in winter, 1 hour in summer).
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
  const lh = Number(parts.find(p => p.type === 'hour').value), off = ((lh - new Date(guess).getUTCHours()) + 24) % 24;
  return Math.floor((guess - off * 3600e3) / 1000);
}
const pick = (o, pre) => {
  const m = {}, map = { H: '1', D: 'X', A: '2', '>2.5': 'O2.5', '<2.5': 'U2.5' };
  for (const [k, key] of Object.entries(map)) { const v = num(o[pre + k]); if (v) m[key] = v; }
  return Object.keys(m).length ? m : null;
};

function load() {
  const dir = path.join(ROOT, 'data/fdco');
  if (!fs.existsSync(dir)) return { rows: [], odds: {}, files: [] };
  const rows = new Map(), odds = {}, snaps = readJSON(path.join(dir, 'snapshots.json'), {});
  const add = (o, code, played) => {
    const L = LEAGUES[code]; if (!L) return;
    const hn = o.HomeTeam || o.Home, an = o.AwayTeam || o.Away; if (!hn || !an || !o.Date) return;
    const hg = o.FTHG ?? o.HG, ag = o.FTAG ?? o.AG, ts = londonTs(o.Date, o.Time);
    const day = new Date(ts * 1000).toISOString().slice(0, 10), id = hash(`${code}|${day}|${hn}|${an}`);
    if (rows.has(id) && rows.get(id).st === 'FT' && !played) return; // a result beats a fixture
    const done = played && hg != null && ag != null;
    rows.set(id, { id, ts, st: done ? 'FT' : 'NS', lg: L[0], ln: L[2], lc: L[1], h: `${code}:${hn}`, hn, a: `${code}:${an}`, an,
      hg: done ? Number(hg) : null, ag: done ? Number(ag) : null });
    const open = pick(o, 'B365'), close = pick(o, 'B365C'), best = pick(o, 'Max'), avg = pick(o, 'Avg');
    if (open || close) odds[id] = { m: close || open, open: close && open ? open : null, best, avg };
    const sn = snaps[`${code}|${o.Date}|${hn}|${an}`];
    if (sn && odds[id] && sn.last.at > sn.first.at) odds[id].snap = sn; // two price snapshots before kick-off
  };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files.filter(f => f.startsWith('res-'))) { const code = f.slice(4, -5); for (const o of readJSON(path.join(dir, f), [])) add(o, code, true); }
  for (const o of readJSON(path.join(dir, 'fixtures.json'), [])) add(o, o.Div, false);
  for (const o of readJSON(path.join(dir, 'fixtures-extra.json'), [])) add(o, BY_COUNTRY[o.Country], false);
  const all = [...rows.values()];
  return { rows: all, odds, pin: matchSharp(all), files, status: readJSON(path.join(dir, 'status.json'), {}) };
}

// --- Pinnacle / Betfair Exchange prices from data/sharp.json (scripts/pinnacle.js) ----------------
// The Odds API uses full club names ("Wolverhampton Wanderers"), football-data short ones ("Wolves").
// A stored event is matched to a football-data row of the same league kicking off within 6 hours,
// choosing the row whose two team names fit best. Rows are never created from these events.
const ALIAS = { 'wolverhampton wanderers': 'wolves', 'nottingham forest': "nott'm forest", 'brighton and hove albion': 'brighton',
  'paris saint germain': 'paris sg', 'borussia monchengladbach': "m'gladbach", 'atletico madrid': 'ath madrid', 'athletic bilbao': 'ath bilbao',
  'inter milan': 'inter', 'ac milan': 'milan', 'sheffield wednesday': 'sheffield weds', 'queens park rangers': 'qpr',
  'west bromwich albion': 'west brom', 'bayer leverkusen': 'leverkusen', 'eintracht frankfurt': 'ein frankfurt', 'celta vigo': 'celta',
  'rayo vallecano': 'vallecano', 'real sociedad': 'sociedad', 'real betis': 'betis', 'espanyol': 'espanol', 'psv eindhoven': 'psv eindhoven',
  'sporting lisbon': 'sp lisbon', 'sporting cp': 'sp lisbon', 'fc porto': 'porto', 'sc braga': 'sp braga', 'vitoria guimaraes': 'guimaraes',
  'fenerbahce': 'fenerbahce', 'galatasaray': 'galatasaray', 'besiktas jk': 'besiktas', 'olympiacos piraeus': 'olympiakos', 'olympiacos': 'olympiakos',
  'panathinaikos': 'panathinaikos', 'aek athens': 'aek', 'paok thessaloniki': 'paok', 'paok': 'paok' };
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'us', 'sv', 'vfb', 'vfl', 'tsg', 'fk', 'sk', 'if', 'bk', 'cd', 'ud', 'sd', 'rc', 'rcd', 'club', 'de', 'the', 'and', 'calcio', '1899', '1900', '1910', '04', '05', '1846', 'hotspur', 'albion']);
const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/\butd\b/g, 'united').replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).replace(/'/g, '').split(' ').filter(t => t && !STOP.has(t));
const tokEq = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
const grams = s => { const t = ' ' + norm(s).replace(/'/g, '') + ' ', g = []; for (let i = 0; i < t.length - 1; i++) g.push(t.slice(i, i + 2)); return g; };
function sim(apiName, fdName) {
  const a0 = norm(apiName), b0 = norm(fdName);
  if (a0 === b0 || ALIAS[a0] === b0) return 1;
  const a = toks(apiName), b = toks(fdName);
  const tk = a.length && b.length ? (b.filter(t => a.some(u => tokEq(t, u))).length / b.length + a.filter(t => b.some(u => tokEq(t, u))).length / a.length) / 2 : 0;
  const ga = grams(apiName), gb = grams(fdName), pool = [...gb]; let common = 0;
  for (const g of ga) { const i = pool.indexOf(g); if (i >= 0) { common++; pool.splice(i, 1); } }
  const dice = (2 * common) / (ga.length + gb.length);
  return Math.max(tk * 0.95, dice);
}
// Pinnacle often quotes its main goal line at 2.25, 2.75 or 3 instead of 2.5. Estimate a fair
// Over/Under 2.5 price from that line: find the average total goals (Poisson) at which the line's
// margin-free Over/Under split matches Pinnacle's, then read off the chance of 3+ goals.
// Quarter lines (x.25 / x.75) are half on each neighbouring line; whole lines refund on the exact total.
const pois = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function lineFair(pt, l) { // model's fair Over and Under odds for a goal line at average total l
  const parts = Math.abs(pt * 4 % 2 - 1) < 1e-9 ? [pt - 0.25, pt + 0.25] : [pt];
  let ow = 0, ol = 0, uw = 0, ul = 0;
  for (const c of parts) for (let g = 0; g <= 15; g++) {
    const p = pois(g, l);
    if (g > c) { ow += p; ul += p; } else if (g < c) { ol += p; uw += p; } // g === c: stake back
  }
  return { o: 1 + ol / ow, u: 1 + ul / uw };
}
function fillO25(pin) {
  if (!pin || pin['O2.5'] || !pin.tot || !(pin.tot.o > 1) || !(pin.tot.u > 1)) return pin;
  const { pt, o, u } = pin.tot, share = (1 / o) / (1 / o + 1 / u);
  let lo = 0.3, hi = 7;
  for (let i = 0; i < 60; i++) { const l = (lo + hi) / 2, f = lineFair(pt, l), s = (1 / f.o) / (1 / f.o + 1 / f.u); if (s < share) lo = l; else hi = l; }
  const l = (lo + hi) / 2, under = pois(0, l) + pois(1, l) + pois(2, l);
  return { ...pin, 'O2.5': Math.round(100000 / (1 - under)) / 100000, 'U2.5': Math.round(100000 / under) / 100000, estFrom: pt };
}
function matchSharp(rows) {
  const store = readJSON(path.join(ROOT, 'data/sharp.json'), { events: {} }), out = {};
  const byCode = new Map();
  for (const r of rows) { const c = r.h.split(':')[0]; if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(r); }
  const used = new Map(); // row id -> score, so the best-fitting event wins a row
  for (const [ev, e] of Object.entries(store.events || {})) {
    let best = null;
    for (const r of byCode.get(e.code) || []) {
      if (Math.abs(r.ts - e.ts) > 6 * 3600) continue;
      const sh = sim(e.home, r.hn), sa = sim(e.away, r.an), sc = sh + sa;
      if (sh >= 0.3 && sa >= 0.3 && sc >= 1.0 && (!best || sc > best.sc)) best = { r, sc };
    }
    if (best && (!used.has(best.r.id) || used.get(best.r.id) < best.sc)) {
      used.set(best.r.id, best.sc);
      out[best.r.id] = { pin: fillO25(e.last.pin), bfx: e.last.bfx, pin0: fillO25(e.first.pin), at: e.last.at, at0: e.first.at, ev };
    }
  }
  return out;
}

module.exports = { load, LEAGUES, sim, fillO25 };
