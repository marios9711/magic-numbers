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
  const rows = new Map(), odds = {};
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
  };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files.filter(f => f.startsWith('res-'))) { const code = f.slice(4, -5); for (const o of readJSON(path.join(dir, f), [])) add(o, code, true); }
  for (const o of readJSON(path.join(dir, 'fixtures.json'), [])) add(o, o.Div, false);
  for (const o of readJSON(path.join(dir, 'fixtures-extra.json'), [])) add(o, BY_COUNTRY[o.Country], false);
  return { rows: [...rows.values()], odds, files, status: readJSON(path.join(dir, 'status.json'), {}) };
}

module.exports = { load, LEAGUES };
