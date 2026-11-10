// Sportmonks pre-match odds recorder: every run (4 a day) takes a snapshot of every bookmaker's
// prices for every upcoming fixture in the next 7 days, in 5 markets: 1X2, double chance,
// both teams to score, goals over/under (all lines 0.5–5.5) and Asian handicap.
//
// Sportmonks keeps odds only until 7 days after kick-off, so this record IS the price history.
// To keep files small, per selection we store only values that changed since the last snapshot:
//   b   best price on offer [t, price, bookmakerId] (exchanges left out; outliers > 15% above the
//       median price are ignored as likely errors)
//   cf  consensus fair chance [t, p]: each bookmaker's margin removed (power method), then the median
//   pf  Pinnacle fair chance [t, p] (the sharp reference, when Pinnacle prices the market)
//   tr  full price series for the tracked bookmakers (Pinnacle, Betfair, Bet365): { bookId: [[t, price]] }
//   n   number of bookmakers pricing it at the last snapshot
// t = minutes since 1970 (UTC). Files: data/sm/odds/YYYY-MM-DD.json by kick-off date.
const S = require('./smlib');

const AHEAD_H = 7 * 24;
const MAX_CALLS = 1500;          // per run
const WORKERS = 4;
const STALE_H = 24;              // ignore prices a bookmaker hasn't confirmed for 24 h
const EXCHANGE = /betfair|exchange|matchbook|smarkets|betdaq/i;
const TRACK = /pinnacle|betfair|bet365/i;
const SHARP = /pinnacle/i;

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = x => Math.round(x * 1e4) / 1e4;

// Rows of one fixture -> { books: { bookId: { key: price } }, groups: { group: [keys] } }
function parse(rows, fx, marketName, nowS) {
  const books = {}, groups = {}, ah = {};
  for (const o of rows) {
    if (o.stopped) continue;
    const price = Number(o.value || o.dp3);
    if (!(price > 1.005) || price > 200) continue;
    if (o.latest_bookmaker_update) {
      const u = Date.parse(o.latest_bookmaker_update.replace(' ', 'T') + 'Z') / 1000;
      if (Number.isFinite(u) && nowS - u > STALE_H * 3600) continue;
    }
    const mk = marketName[o.market_id];
    if (!mk) continue;
    const k = S.keyOf(o, mk, fx.hn, fx.an);
    if (!k) continue;
    if (mk === 'AH') { (ah[o.bookmaker_id] = ah[o.bookmaker_id] || []).push({ ...k, price }); continue; }
    (books[o.bookmaker_id] = books[o.bookmaker_id] || {})[k.key] = price;
    if (k.group !== 'DC') (groups[k.group] = groups[k.group] || new Set()).add(k.key);
  }
  // Asian handicap: work out per bookmaker whether the away line is quoted from the away side's
  // view (home -0.5 / away +0.5, the usual way) or from the home side's view (both -0.5).
  for (const [bid, list] of Object.entries(ah)) {
    const H = new Set(list.filter(x => x.side === 'H').map(x => x.line));
    const A = list.filter(x => x.side === 'A');
    const own = A.filter(x => H.has(-x.line)).length, homeView = A.filter(x => x.line !== 0 && H.has(x.line)).length;
    const flip = homeView > own;
    const b = books[bid] = books[bid] || {};
    for (const x of list) {
      let key = x.key, g;
      if (x.side === 'H') g = `AH${S.fmtLine(x.line)}`;
      else { const awayLine = flip ? -x.line : x.line; key = `AHA${S.fmtLine(awayLine)}`; g = `AH${S.fmtLine(-awayLine)}`; }
      b[key] = x.price;
      (groups[g] = groups[g] || new Set()).add(key);
    }
  }
  for (const g of Object.keys(groups)) {
    groups[g] = [...groups[g]];
    const want = g === '1X2' ? 3 : 2;
    if (groups[g].length !== want) delete groups[g];
  }
  return { books, groups };
}

function summarise({ books, groups }, bookNames) {
  const out = {};
  const sharpIds = Object.keys(books).filter(id => SHARP.test(bookNames[id] || ''));
  const fairOf = (b, keys) => keys.every(k => b[k] > 1) ? S.powerFair(keys.map(k => b[k])) : null;
  for (const [g, keys] of Object.entries(groups)) {
    const per = Object.values(books).map(b => fairOf(b, keys)).filter(Boolean);
    if (!per.length) continue;
    let cf = keys.map((_, i) => median(per.map(f => f[i])));
    const s = cf.reduce((a, b) => a + b, 0); cf = cf.map(x => x / s);
    let pf = null;
    for (const id of sharpIds) { pf = fairOf(books[id], keys); if (pf) break; }
    keys.forEach((k, i) => { out[k] = { cf: cf[i], pf: pf ? pf[i] : null }; });
  }
  // Double chance chances come from 1X2 (DC prices carry a double margin).
  if (out['1'] && out.X && out['2']) {
    const f = (a, b, w) => (out[a][w] != null && out[b][w] != null ? out[a][w] + out[b][w] : null);
    out.DC1X = { cf: f('1', 'X', 'cf'), pf: f('1', 'X', 'pf') };
    out.DC12 = { cf: f('1', '2', 'cf'), pf: f('1', '2', 'pf') };
    out.DCX2 = { cf: f('X', '2', 'cf'), pf: f('X', '2', 'pf') };
  }
  // Best price, prices per tracked bookmaker, number of bookmakers.
  for (const key of Object.keys(out)) {
    const offers = Object.entries(books).filter(([, b]) => b[key] > 1).map(([id, b]) => [id, b[key]]);
    const nonEx = offers.filter(([id]) => !EXCHANGE.test(bookNames[id] || ''));
    const med = nonEx.length ? median(nonEx.map(x => x[1])) : null;
    let best = null;
    for (const [id, pr] of nonEx) if ((nonEx.length < 3 || pr <= med * 1.15) && (!best || pr > best[1])) best = [Number(id), pr];
    const tr = {};
    for (const [id, pr] of offers) if (TRACK.test(bookNames[id] || '')) tr[id] = pr;
    Object.assign(out[key], { best, tr, n: offers.length });
  }
  return out;
}

function append(series, val, tm, same) {
  const last = series[series.length - 1];
  if (!last || !same(last, val)) series.push([tm, ...val]);
}

function record(rec, sum, tm) {
  rec.o = rec.o || {};
  for (const [key, v] of Object.entries(sum)) {
    const o = rec.o[key] = rec.o[key] || { b: [], cf: [], pf: [], tr: {} };
    if (v.best) append(o.b, [v.best[1], v.best[0]], tm, (l, x) => Math.abs(l[1] / x[0] - 1) < 0.005 && l[2] === x[1]);
    if (v.cf != null) append(o.cf, [r4(v.cf)], tm, (l, x) => Math.abs(l[1] - x[0]) < 0.002);
    if (v.pf != null) append(o.pf, [r4(v.pf)], tm, (l, x) => Math.abs(l[1] - x[0]) < 0.002);
    for (const [id, pr] of Object.entries(v.tr)) append(o.tr[id] = o.tr[id] || [], [pr], tm, (l, x) => Math.abs(l[1] / x[0] - 1) < 0.005);
    o.n = v.n;
    o.at = tm;                         // last snapshot that priced this selection
    if (v.pf != null) o.pfAt = tm;     // last snapshot where Pinnacle priced it
  }
}

async function main() {
  if (!S.needKey('odds.js')) return;
  const st = S.loadState();
  const mk = st.markets || { '1X2': 1, DC: 2, BTTS: 14, OU: 80, AH: null };
  const marketName = {};
  for (const [name, id] of Object.entries(mk)) if (id) marketName[id] = name;
  const ids = Object.values(mk).filter(Boolean).join(',');
  const up = S.readJSON(S.p('upcoming.json'), { fixtures: [] }).fixtures;
  const nowS = S.now(), tm = Math.floor(nowS / 60);
  const list = up.filter(f => f.ts > nowS + 300 && f.ts < nowS + AHEAD_H * 3600 && f.odds !== false).slice(0, MAX_CALLS);

  const files = {}; // date -> data
  const fileOf = f => { const d = S.day(f.ts); return files[d] = files[d] || S.readJSON(S.p(`odds/${d}.json`), {}); };
  let done = 0, empty = 0, failed = 0, stop = null, i = 0, sharpSeen = 0;
  const newBooks = new Set();

  async function worker() {
    while (!stop && i < list.length) {
      const f = list[i++];
      try {
        const j = await S.get(`/football/odds/pre-match/fixtures/${f.id}`, { filters: `markets:${ids}` });
        if (j && j.rate_limit && j.rate_limit.remaining < 30) stop = `odds calls left ${j.rate_limit.remaining}`;
        const rows = (j && j.data) || [];
        for (const o of rows) if (!st.books[o.bookmaker_id]) newBooks.add(o.bookmaker_id);
        const parsed = parse(rows, f, marketName, nowS);
        if (!Object.keys(parsed.groups).length) { empty++; continue; }
        const sum = summarise(parsed, st.books);
        if (Object.values(sum).some(v => v.pf != null)) sharpSeen++;
        const data = fileOf(f);
        const rec = data[f.id] = data[f.id] || {};
        Object.assign(rec, { id: f.id, lg: f.lg, ts: f.ts, hn: f.hn, an: f.an, h: f.h, a: f.a });
        rec.snaps = (rec.snaps || []).concat(tm).slice(-80);
        record(rec, sum, tm);
        done++;
      } catch (e) {
        if (e.rateLimited) { stop = 'rate limit'; break; }
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  for (const [d, data] of Object.entries(files)) S.writeJSON(S.p(`odds/${d}.json`), data);

  // Bookmakers we have no name for yet (new ones appear): look them up by id.
  for (const id of [...newBooks].slice(0, 40)) {
    try { const j = await S.get(`/odds/bookmakers/${id}`); if (j && j.data) st.books[id] = j.data.name; } catch { /* keep the id */ }
  }
  const log = { job: 'odds', candidates: list.length, recorded: done, noOdds: empty, failed, withPinnacle: sharpSeen, stopped: stop };
  S.saveState(st, log);
  console.log('odds.js', JSON.stringify(log));
}

if (require.main === module) main().catch(e => { console.error('odds.js failed:', e.message); process.exitCode = 1; });
module.exports = { parse, summarise };
