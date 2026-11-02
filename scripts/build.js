// Builds the website data from all collected days.
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON, writeJSON, evaluate, stats, slim } = require('./lib');
const { goalsModel, judge, RULES, fairProb } = require('./goals');

const dir = path.join(ROOT, 'data/days');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const byId = new Map();
for (const f of files) for (const r of readJSON(path.join(dir, f), { rows: [] }).rows) byId.set(r.id, r); // newer files win

const { results, hist } = evaluate([...byId.values()]);
const G = goalsModel([...byId.values()]);
const now = Date.now() / 1000;

const odds = readJSON(path.join(ROOT, 'data/odds.json'), {});
const withOdds = x => {
  const o = odds[x.id]; if (o && o.m && Object.keys(o.m).length) { x.od = o.m; x.bm = o.bm; if (o.open && o.open.at < o.at) x.op = o.open.m; }
  const g = judge(G.get(x.id), x.od); if (g) x.g = g;
  return x;
};
const upcoming = results
  .filter(x => !x.outcome && x.row.ts > now - 3 * 3600 && x.row.ts < now + 2 * 864e2)
  .map(slim).map(withOdds);
const settledAll = results.filter(x => x.outcome && (x.pred || G.get(x.row.id))).map(slim).map(withOdds);

// Daily Top 3 (per UTC calendar day): strong Over 2.5 selections first, ranked by value;
// remaining places go to the book's 1/X/2 picks (high/medium confidence, odds 1.80–4.00,
// bookmaker margin ≤ 8%), ranked by the book's own margin. One selection per match.
const BOOK = { minOdds: 1.80, maxOdds: 4.0, maxMargin: 0.08 };
const bookMargin = s => { const v = Object.values(s).sort((a, b) => b - a), t = v.reduce((a, b) => a + b, 0); return t ? (v[0] - v[1]) / t : 0; };
function top3(xs) {
  const over = xs.filter(x => x.g && x.g.strong).sort((a, b) => b.g.edge - a.g.edge)
    .map(x => ({ x, m: 'O2.5', kind: 'Over 2.5 goals', odd: x.g.o, why: x.g.pass }));
  const book = xs.filter(x => {
    if (!(x.p && x.od && (x.p.conf === 'high' || x.p.conf === 'medium'))) return false;
    const odd = x.od[x.p.pick], mg = x.od['1'] && x.od.X && x.od['2'] ? 1 / x.od['1'] + 1 / x.od.X + 1 / x.od['2'] - 1 : 1;
    return odd >= BOOK.minOdds && odd <= BOOK.maxOdds && mg <= BOOK.maxMargin;
  }).sort((a, b) => bookMargin(b.p.s) - bookMargin(a.p.s))
    .map(x => ({ x, m: x.p.pick, kind: 'Book’s pick', odd: x.od[x.p.pick], why: [`${x.p.conf} confidence`, ...x.p.why.slice(0, 3)] }));
  const seen = new Set(), out = [];
  for (const c of [...over, ...book]) { if (out.length === 3) break; if (seen.has(c.x.id)) continue; seen.add(c.x.id); out.push(c); }
  return out;
}
const dayKey = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const byDay = xs => { const m = new Map(); for (const x of xs) { const k = dayKey(x.ts); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const goalHit = x => x.hg + x.ag > 2;
const hitTop = (c, x) => c.m === 'O2.5' ? goalHit(x) : ({ '1': x.o === 'H', X: x.o === 'D', '2': x.o === 'A' })[c.m];
const settled = settledAll.filter(x => x.p).slice().reverse().slice(0, 1000);

// Paper betting: a pretend €10 stake on each market, at the odds recorded before kick-off.
const STAKE = 10;
const hitM = (m, o) => ({ '1': o === 'H', X: o === 'D', '2': o === 'A', '1X': o !== 'A', X2: o !== 'H', '12': o !== 'D' })[m];
const MK = {
  pick: x => x.p.pick,
  dc: x => x.p.dc,
  underdog: x => x.p.ud,
  home: () => '1',
  favourite: x => ['1', 'X', '2'].filter(k => x.od[k]).sort((a, b) => x.od[a] - x.od[b])[0],
};
const paper = { stake: STAKE, markets: {}, byLeague: {}, timeline: [] };
for (const k in MK) paper.markets[k] = { bets: 0, won: 0, profit: 0 };
for (const k of ['over25', 'top3']) paper.markets[k] = { bets: 0, won: 0, profit: 0 };
const addBet = (k, odd, ok) => { const a = paper.markets[k], pr = ok ? STAKE * (odd - 1) : -STAKE; a.bets++; if (ok) a.won++; a.profit += pr; };
for (const x of settledAll) if (x.g && x.g.strong) addBet('over25', x.g.o, goalHit(x));
const top3Hist = [];
for (const [d, xs] of byDay(settledAll)) {
  const picks = top3(xs);
  for (const c of picks) addBet('top3', c.odd, hitTop(c, c.x));
  if (picks.length) top3Hist.push({ d, picks: picks.map(c => ({ hn: c.x.hn, an: c.x.an, m: c.m, odd: c.odd, ok: hitTop(c, c.x), sc: `${c.x.hg}–${c.x.ag}` })) });
}
paper.top3Recent = top3Hist.slice(-14).reverse();

// Closing line value: did the first price we saw beat the bookmaker's later fair price?
// value = open odds x latest margin-free probability - 1 (positive = we got a better price
// than the market settled on). Only matches priced in two or more runs count.
const clv = {};
const addClv = (k, x, mk) => {
  const o = x.op && x.op[mk], fp = fairProb(x.od, mk);
  if (!o || fp == null) return;
  const v = o * fp - 1, a = (clv[k] ||= { n: 0, sum: 0, pos: 0 });
  a.n++; a.sum += v; if (v > 0) a.pos++;
};
for (const x of settledAll) {
  if (!x.od) continue;
  if (x.p) { addClv('pick', x, x.p.pick); addClv('home', x, '1'); const fav = MK.favourite(x); if (fav) addClv('favourite', x, fav); }
  if (x.g && x.g.strong) addClv('over25', x, 'O2.5');
}
for (const [, xs] of byDay(settledAll)) for (const c of top3(xs)) addClv('top3', c.x, c.m);
for (const k in clv) { const a = clv[k]; clv[k] = { n: a.n, avg: Math.round(1000 * a.sum / a.n) / 10, pos: Math.round(1000 * a.pos / a.n) / 10 }; }
paper.clv = clv;
const cum = Object.fromEntries(Object.keys(MK).map(k => [k, 0]));
const days = new Map();
for (const x of settledAll.filter(x => x.od && x.p).sort((a, b) => a.ts - b.ts)) {
  for (const k in MK) {
    const m = MK[k](x), odd = m && x.od[m];
    if (!odd) continue;
    const pr = hitM(m, x.o) ? STAKE * (odd - 1) : -STAKE;
    const a = paper.markets[k]; a.bets++; if (pr > 0) a.won++; a.profit += pr; cum[k] += pr;
    if (k === 'pick') { const l = (paper.byLeague[x.lg] ||= { bets: 0, won: 0, profit: 0 }); l.bets++; if (pr > 0) l.won++; l.profit += pr; }
  }
  days.set(new Date(x.ts * 1000).toISOString().slice(0, 10), { ...cum });
}
paper.timeline = [...days].map(([d, v]) => ({ d, ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n * 100) / 100])) }));
for (const g of [paper.markets, paper.byLeague]) for (const k in g) g[k].profit = Math.round(g[k].profit * 100) / 100;

const ready = [...hist.values()].filter(h => h.length >= 7).length;
const S = stats(results);
S.meta = {
  updated: new Date().toISOString(),
  daysCollected: files.length,
  firstDay: files[0] ? files[0].slice(0, 10) : null,
  lastDay: files.length ? files[files.length - 1].slice(0, 10) : null,
  fixtures: byId.size,
  teams: hist.size,
  teamsReady: ready,
  upcomingTotal: results.filter(x => !x.outcome && x.row.ts > now - 3 * 3600).length,
  upcomingPredicted: upcoming.filter(x => x.p).length,
};
S.paper = paper;

// Team list for the calculator: name, latest competition, last 8 results (oldest -> newest).
const info = new Map();
for (const r of [...byId.values()].sort((x, y) => x.ts - y.ts)) {
  info.set(r.h, { n: r.hn, l: `${r.lc} – ${r.ln}` });
  info.set(r.a, { n: r.an, l: `${r.lc} – ${r.ln}` });
}
const teams = [...hist.entries()].filter(([, h]) => h.length).map(([id, h]) => {
  const t = info.get(id) || { n: String(id), l: '' };
  const last = h.slice(-8);
  return { n: t.n, l: t.l, r: last.map(m => m.r).join(''), h: last.map(m => (m.home ? 1 : 0)).join('') };
}).sort((a, b) => a.n.localeCompare(b.n));

const out = path.join(ROOT, 'docs/data');
writeJSON(path.join(out, 'teams.json'), teams);
writeJSON(path.join(out, 'upcoming.json'), upcoming);
writeJSON(path.join(out, 'settled.json'), settled);
writeJSON(path.join(out, 'stats.json'), S);
// Today's and tomorrow's Top 3 from all of that day's matches (kicked off or not), so the
// list matches what paper betting grades afterwards.
const allDay = results.filter(x => dayKey(x.row.ts) >= dayKey(now)).map(slim).map(withOdds);
const T3 = byDay(allDay);
writeJSON(path.join(out, 'top3.json'), {
  rules: { over: RULES, book: BOOK },
  days: [0, 1].map(o => dayKey(now + o * 864e2)).map(d => ({ d, picks: top3(T3.get(d) || []).map(c => ({
    ts: c.x.ts, hn: c.x.hn, an: c.x.an, lg: c.x.lg, m: c.m, kind: c.kind, odd: c.odd, why: c.why, p: c.m === 'O2.5' ? c.x.g.p : null, started: c.x.ts <= now,
  })) })),
});
console.log(`days=${files.length} fixtures=${byId.size} teamsReady=${ready}/${hist.size} upcoming=${upcoming.length} (predicted ${S.meta.upcomingPredicted}) graded=${S.graded}`);
