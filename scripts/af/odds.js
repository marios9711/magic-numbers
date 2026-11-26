// API-Football pre-match odds recorder: every run takes a snapshot of every bookmaker's prices for
// the fixtures of today and the next 2 days (UTC dates), from /odds?date= (10 fixtures a page).
// Markets: 1X2, double chance, both teams to score, goals over/under, 1st-half over/under, Asian
// handicap. The rows are turned into the Sportmonks row shape so the same parse/summarise/record
// code (scripts/sm/odds.js) builds data/af/odds/YYYY-MM-DD.json in the same format.
// API-Football refreshes pre-match odds about every 3 hours.
const S = require('../sm/smlib');
const A = require('./aflib');
const { parse, summarise } = require('../sm/odds');

// Same as record() in scripts/sm/odds.js: keep only values that changed since the last snapshot.
const r4 = x => Math.round(x * 1e4) / 1e4;
function append(series, val, tm, same) { const l = series[series.length - 1]; if (!l || !same(l, val)) series.push([tm, ...val]); }
function record(rec, sum, tm) {
  rec.o = rec.o || {};
  for (const [key, v] of Object.entries(sum)) {
    const o = rec.o[key] = rec.o[key] || { b: [], cf: [], pf: [], tr: {} };
    if (v.best) append(o.b, [v.best[1], v.best[0]], tm, (l, x) => Math.abs(l[1] / x[0] - 1) < 0.005 && l[2] === x[1]);
    if (v.cf != null) append(o.cf, [r4(v.cf)], tm, (l, x) => Math.abs(l[1] - x[0]) < 0.002);
    if (v.pf != null) append(o.pf, [r4(v.pf)], tm, (l, x) => Math.abs(l[1] - x[0]) < 0.002);
    for (const [id, pr] of Object.entries(v.tr)) append(o.tr[id] = o.tr[id] || [], [pr], tm, (l, x) => Math.abs(l[1] / x[0] - 1) < 0.005);
    o.n = v.n; o.at = tm;
    if (v.pf != null) o.pfAt = tm;
  }
}

const DAYS = Number(process.env.AF_ODDS_DAYS || 3);
const MAX_PAGES = Number(process.env.AF_ODDS_PAGES || 40); // per date

// One API-Football odds item -> Sportmonks-like rows { bookmaker_id, market_id, label, total, handicap, value }
function rowsOf(item) {
  const rows = [];
  for (const b of item.bookmakers || []) {
    for (const bet of b.bets || []) {
      for (const v of bet.values || []) {
        const val = String(v.value), row = { bookmaker_id: b.id, market_id: bet.id, value: Number(v.odd) };
        let m;
        if ((m = /^(Over|Under)\s+([\d.]+)$/i.exec(val))) Object.assign(row, { label: m[1], total: m[2] });
        else if ((m = /^(Home|Away)\s*([+-]?[\d.]+)$/i.exec(val))) Object.assign(row, { label: m[1], handicap: m[2] });
        else row.label = val;
        rows.push(row);
      }
    }
  }
  return rows;
}

async function main() {
  if (!S.needKey('af/odds.js')) return;
  const st = S.loadState();
  const mk = st.markets || { '1X2': 1, AH: 4, OU: 5, HOU: 6, BTTS: 8, DC: 12 };
  const marketName = {};
  for (const [name, id] of Object.entries(mk)) if (id) marketName[id] = name;
  const up = new Map(S.readJSON(S.p('upcoming.json'), { fixtures: [] }).fixtures.map(f => [f.id, f]));
  const nowS = S.now(), tm = Math.floor(nowS / 60);
  const files = {};
  const fileOf = f => { const d = S.day(f.ts); return files[d] = files[d] || S.readJSON(S.p(`odds/${d}.json`), {}); };
  const leagues = new Set(st.oddsLeagues || []);
  let items = 0, done = 0, empty = 0, unknown = 0, sharpSeen = 0, stop = null;
  for (let n = 0; n < DAYS && !stop; n++) {
    const date = new Date((nowS + n * 86400) * 1000).toISOString().slice(0, 10);
    let list = [];
    try { list = await A.all('/odds', { date }, MAX_PAGES); }
    catch (e) { if (e.rateLimited) { stop = e.message; break; } console.log('odds', date, 'failed:', e.message); continue; }
    for (const item of list) {
      items++;
      const f = up.get(item.fixture.id);
      if (!f) { unknown++; continue; }            // not in upcoming.json (started, or a skipped league)
      if (f.ts <= nowS + 300) continue;
      const parsed = parse(rowsOf(item), f, marketName, nowS);
      if (!Object.keys(parsed.groups).length) { empty++; continue; }
      const sum = summarise(parsed, st.books);
      if (Object.values(sum).some(v => v.pf != null)) sharpSeen++;
      const data = fileOf(f);
      const rec = data[f.id] = data[f.id] || {};
      Object.assign(rec, { id: f.id, lg: f.lg, sid: f.sid, ts: f.ts, hn: f.hn, an: f.an, h: f.h, a: f.a });
      rec.snaps = (rec.snaps || []).concat(tm).slice(-80);
      record(rec, sum, tm);
      leagues.add(f.lg);
      done++;
    }
  }
  for (const [d, data] of Object.entries(files)) S.writeJSON(S.p(`odds/${d}.json`), data);
  st.oddsLeagues = [...leagues];
  const log = { job: 'odds', items, recorded: done, noOdds: empty, notUpcoming: unknown, withPinnacle: sharpSeen, stopped: stop, calls: A.callCount(), left: A.remaining() };
  S.saveState(st, log);
  console.log('af/odds.js', JSON.stringify(log));
}

if (require.main === module) main().catch(e => { console.error('af/odds.js failed:', e.message); process.exitCode = 1; });
module.exports = { rowsOf };
