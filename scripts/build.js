// Builds the website data from all collected days.
// SOURCE=fd builds the main site (docs/) from football-data.co.uk files; without it the API-Football
// version is built into docs/api/.
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON, writeJSON, evaluate, stats, slim } = require('./lib');
const { goalsModel, judge, RULES, ALT, fairProb } = require('./goals');
const { ratingsModel } = require('./ratings');

const FD = process.env.SOURCE === 'fd';
const FDATA = FD ? require('./fdsource').load() : null;
const dir = path.join(ROOT, 'data/days');
const files = FD ? [] : fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const byId = new Map();
if (FD) for (const r of FDATA.rows) byId.set(r.id, r);
for (const f of files) for (const r of readJSON(path.join(dir, f), { rows: [] }).rows) byId.set(r.id, r); // newer files win

const { results, hist } = evaluate([...byId.values()]);
const R = ratingsModel([...byId.values()]);
const G = goalsModel([...byId.values()], R);
const now = Date.now() / 1000;

const odds = FD ? {} : readJSON(path.join(ROOT, 'data/odds.json'), {});
const bestOdds = FD ? {} : readJSON(path.join(ROOT, 'data/best.json'), {});
const withOdds = x => {
  const o = odds[x.id]; if (o && o.m && Object.keys(o.m).length) { x.od = o.m; x.bm = o.bm; if (o.open && o.open.at < o.at) x.op = o.open.m; }
  const f = FD && FDATA.odds[x.id];
  if (f) {
    x.od = f.m; x.bm = 'Bet365'; if (f.open) x.op = f.open; if (f.avg) x.avg = f.avg;
    if (f.best) { x.best = Object.fromEntries(Object.entries(f.best).map(([k, v]) => [k, [v, 'best on the market']])); }
  }
  const g = judge(G.get(x.id), x.od); if (g) x.g = g;
  const bo = bestOdds[x.id]; if (bo && bo.b) { x.best = bo.b; x.nb = bo.n; }
  const r = R.get(x.id);
  if (r) { const p = { '1': r.H, X: r.D, '2': r.A }, r3 = v => Math.round(v * 1000) / 1000;
    x.r = { '1': r3(r.H), X: r3(r.D), '2': r3(r.A), pick: Object.keys(p).sort((a, b) => p[b] - p[a])[0], lh: Math.round(r.lh * 100) / 100, la: Math.round(r.la * 100) / 100 }; }
  return x;
};
const upcoming = results
  .filter(x => !x.outcome && x.row.ts > now - 3 * 3600 && x.row.ts < now + (FD ? 7 : 2) * 864e2)
  .map(slim).map(withOdds);
const settledAll = results.filter(x => x.outcome && (x.pred || G.get(x.row.id) || R.get(x.row.id))).map(slim).map(withOdds);

// Daily Top 3 (per UTC calendar day): strong Over 2.5 selections first, ranked by value;
// remaining places go to the book's 1/X/2 picks (high/medium confidence, odds 1.80–4.00,
// bookmaker margin ≤ 8%) that the ratings model also rates as value (its chance x odds ≥ 1.05),
// ranked by that value. One selection per match.
const BOOK = { minOdds: 1.80, maxOdds: 4.0, maxMargin: 0.08, minEdge: 1.05 };
const pct0 = v => `${Math.round(v * 100)}%`;
const LINE = { O: 'Over', U: 'Under' };
// Top 3 goal selections: strong Over 2.5 only. The other value lines are still shown and
// tracked on paper ('alt'), but were taken out of the Top 3 on 2 Nov 2026 after the historical
// odds test: Under 2.5 value picks lost 13–16% at real Bet365 prices; 1.5/3.5 lines are untested.
const TOP3_ALT = false;
function goalsPick(x) {
  const c = [];
  if (x.g && x.g.strong) c.push({ x, m: 'O2.5', kind: 'Over 2.5 goals', odd: x.g.o, p: x.g.p, v: x.g.p * x.g.o, why: x.g.pass });
  if (TOP3_ALT && x.g && x.g.alt) { const a = x.g.alt; c.push({ x, m: a.k, kind: `${LINE[a.k[0]]} ${a.k.slice(1)} goals`, odd: a.o, p: a.p, v: a.v,
    why: [`our chance ${pct0(a.p)}${a.fair != null ? ` vs bookmaker ${pct0(a.fair)}` : ''}`, `value ${a.v.toFixed(2)} (need ${ALT.minEdge}+)`, `odds ${a.o.toFixed(2)}`, 'league match'] }); }
  return c.sort((a, b) => b.v - a.v)[0] || null;
}
function top3(xs, n = 3) {
  const over = xs.map(goalsPick).filter(Boolean).sort((a, b) => b.v - a.v);
  const book = xs.filter(x => {
    if (!(x.p && x.r && x.od && (x.p.conf === 'high' || x.p.conf === 'medium'))) return false;
    const odd = x.od[x.p.pick], mg = x.od['1'] && x.od.X && x.od['2'] ? 1 / x.od['1'] + 1 / x.od.X + 1 / x.od['2'] - 1 : 1;
    return odd >= BOOK.minOdds && odd <= BOOK.maxOdds && mg <= BOOK.maxMargin && x.r[x.p.pick] * odd >= BOOK.minEdge;
  }).sort((a, b) => b.r[b.p.pick] * b.od[b.p.pick] - a.r[a.p.pick] * a.od[a.p.pick])
    .map(x => { const odd = x.od[x.p.pick], rp = x.r[x.p.pick], fp = fairProb(x.od, x.p.pick);
      return { x, m: x.p.pick, kind: 'Book’s pick', odd, p: rp,
        why: [`ratings chance ${pct0(rp)}${fp != null ? ` vs bookmaker ${pct0(fp)}` : ''}`, `value ${(rp * odd).toFixed(2)}`, `${x.p.conf} confidence`, ...x.p.why.slice(0, 2)] }; });
  const seen = new Set(), out = [];
  for (const c of [...over, ...book]) { if (out.length === n) break; if (seen.has(c.x.id)) continue; seen.add(c.x.id); out.push(c); }
  return out;
}
const dayKey = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const byDay = xs => { const m = new Map(); for (const x of xs) { const k = dayKey(x.ts); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const goalHit = x => x.hg + x.ag > 2;
const lineHit = (m, x) => m[0] === 'O' ? x.hg + x.ag > Number(m.slice(1)) : x.hg + x.ag < Number(m.slice(1));
const hitTop = (c, x) => /^[OU]\d/.test(c.m) ? lineHit(c.m, x) : ({ '1': x.o === 'H', X: x.o === 'D', '2': x.o === 'A' })[c.m];
// Price beats the market: best price x the market-average chance (margin removed) >= 1.04.
// Historical test (best vs average, 2022–24): +10.5% over 302 bets — promising, not proven.
const SHARP = { minEdge: 1.04, maxOdds: 5 };
function sharpPicks(x) {
  if (!x.best || !x.avg) return [];
  const out = [];
  for (const k of ['1', 'X', '2', 'O2.5', 'U2.5']) {
    const b = x.best[k] && x.best[k][0], fp = fairProb(x.avg, k);
    if (b && fp != null && b <= SHARP.maxOdds && b * fp >= SHARP.minEdge) out.push({ x, m: k, odd: b, fair: fp, v: b * fp });
  }
  return out;
}
// Daily Over 2.5 Top 3: always the three matches most likely to have 3+ goals, ranked by the average
// of our goals model and the bookmaker's own chance (margin removed). Historical test 2022–24 (Bet365
// prices, 593 days): won 61.6% at average odds ~1.59, return −3.8% at Bet365 and −1.0% at the best price.
function overScore(x) {
  if (!x.g || !x.od || !x.od['O2.5'] || !x.od['U2.5']) return null;
  const f = fairProb(x.od, 'O2.5'); return f == null ? null : (x.g.p + f) / 2;
}
const overTop = xs => xs.map(x => ({ x, s: overScore(x) })).filter(c => c.s != null).sort((a, b) => b.s - a.s).slice(0, 3);
const bestOf = (x, m) => (x.best && x.best[m] && x.best[m][0] > ((x.od && x.od[m]) || 0)) ? x.best[m] : null;
const settled = settledAll.filter(x => x.p).slice().reverse().slice(0, 1000);

// Paper betting: a pretend €10 stake on each market, at the odds recorded before kick-off.
const STAKE = 10;
const hitM = (m, o) => ({ '1': o === 'H', X: o === 'D', '2': o === 'A', '1X': o !== 'A', X2: o !== 'H', '12': o !== 'D' })[m];
const MK = {
  pick: x => x.p.pick,
  ratings: x => x.r && x.r.pick,
  dc: x => x.p.dc,
  underdog: x => x.p.ud,
  home: () => '1',
  favourite: x => ['1', 'X', '2'].filter(k => x.od[k]).sort((a, b) => x.od[a] - x.od[b])[0],
};
const paper = { stake: STAKE, markets: {}, byLeague: {}, timeline: [] };
for (const k in MK) paper.markets[k] = { bets: 0, won: 0, profit: 0 };
for (const k of ['over25', 'alt', 'top3', 'top3best', 'sharp', 'over3', 'over3best']) paper.markets[k] = { bets: 0, won: 0, profit: 0 };
const addBet = (k, odd, ok) => { const a = paper.markets[k], pr = ok ? STAKE * (odd - 1) : -STAKE; a.bets++; if (ok) a.won++; a.profit += pr; a.sq = (a.sq || 0) + (pr / STAKE) ** 2; };
for (const x of settledAll) if (x.g && x.g.strong) addBet('over25', x.g.o, goalHit(x));
for (const x of settledAll) for (const c of sharpPicks(x)) addBet('sharp', c.odd, hitTop(c, x));
for (const x of settledAll) if (x.g && x.g.alt) addBet('alt', x.g.alt.o, lineHit(x.g.alt.k, x));
const top3Hist = [];
for (const [d, xs] of byDay(settledAll)) {
  const picks = top3(xs);
  for (const c of picks) { addBet('top3', c.odd, hitTop(c, c.x)); const bp = bestOf(c.x, c.m); addBet('top3best', bp ? bp[0] : c.odd, hitTop(c, c.x)); }
  if (picks.length) top3Hist.push({ d, picks: picks.map(c => ({ hn: c.x.hn, an: c.x.an, m: c.m, odd: c.odd, ok: hitTop(c, c.x), sc: `${c.x.hg}–${c.x.ag}` })) });
}
paper.top3Recent = top3Hist.slice(-14).reverse();
const overHist = [];
for (const [d, xs] of byDay(settledAll)) {
  const picks = overTop(xs);
  for (const c of picks) { addBet('over3', c.x.od['O2.5'], goalHit(c.x)); const bp = bestOf(c.x, 'O2.5'); addBet('over3best', bp ? bp[0] : c.x.od['O2.5'], goalHit(c.x)); }
  if (picks.length) overHist.push({ d, picks: picks.map(c => ({ hn: c.x.hn, an: c.x.an, m: 'O2.5', odd: c.x.od['O2.5'], ok: goalHit(c.x), sc: `${c.x.hg}–${c.x.ag}` })) });
}
paper.overRecent = overHist.slice(-14).reverse();

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
  if (x.p && x.r) addClv('ratings', x, x.r.pick);
  if (x.p) { addClv('pick', x, x.p.pick); addClv('home', x, '1'); const fav = MK.favourite(x); if (fav) addClv('favourite', x, fav); }
  if (x.g && x.g.strong) addClv('over25', x, 'O2.5');
  if (x.g && x.g.alt) addClv('alt', x, x.g.alt.k);
}
for (const [, xs] of byDay(settledAll)) for (const c of top3(xs)) addClv('top3', c.x, c.m);
for (const k in clv) { const a = clv[k]; clv[k] = { n: a.n, avg: Math.round(1000 * a.sum / a.n) / 10, pos: Math.round(1000 * a.pos / a.n) / 10 }; }
paper.clv = clv;

// Against the bookmaker: how often each bet type won compared with how often the bookmaker's
// own (margin-free) price said it should. Positive gap = we pick better than the market.
const vm = {};
const addVm = (k, x, mk, ok) => { const fp = fairProb(x.od, mk); if (fp == null) return; const a = (vm[k] ||= { n: 0, hit: 0, exp: 0 }); a.n++; if (ok) a.hit++; a.exp += fp; };
for (const x of settledAll) {
  if (!x.od) continue;
  if (x.p && x.r) addVm('ratings', x, x.r.pick, hitM(x.r.pick, x.o));
  if (x.p) { addVm('pick', x, x.p.pick, hitM(x.p.pick, x.o)); addVm('home', x, '1', x.o === 'H'); const fav = MK.favourite(x); if (fav) addVm('favourite', x, fav, hitM(fav, x.o)); }
  if (x.g && x.g.strong) addVm('over25', x, 'O2.5', goalHit(x));
  if (x.g && x.g.alt) addVm('alt', x, x.g.alt.k, lineHit(x.g.alt.k, x));
}
for (const [, xs] of byDay(settledAll)) for (const c of top3(xs)) addVm('top3', c.x, c.m, hitTop(c, c.x));
for (const k in vm) { const a = vm[k]; vm[k] = { n: a.n, hit: Math.round(1000 * a.hit / a.n) / 10, exp: Math.round(1000 * a.exp / a.n) / 10 }; }
// Accuracy scores (Brier: lower is better; 0 = perfect). Over 2.5: our model vs the bookmaker
// vs a flat 50%. 1X2: the book's rule scores turned into shares vs the bookmaker's fair chances.
const br = { over: { n: 0, model: 0, market: 0, flat: 0 }, ratings: { n: 0, model: 0, market: 0, flat: 0 }, book: { n: 0, model: 0, market: 0, flat: 0 } };
for (const x of settledAll) {
  if (x.g && x.g.fair != null) {
    const y = goalHit(x) ? 1 : 0, a = br.over;
    a.n++; a.model += (x.g.p - y) ** 2; a.market += (x.g.fair - y) ** 2; a.flat += (0.5 - y) ** 2;
  }
  const f = x.od && ['1', 'X', '2'].map(k => fairProb(x.od, k));
  if (x.r && f && f.every(v => v != null)) {
    const rk = [x.r['1'], x.r.X, x.r['2']], y = ['H', 'D', 'A'].map(o => (x.o === o ? 1 : 0)), a = br.ratings;
    a.n++; for (let i = 0; i < 3; i++) { a.model += (rk[i] - y[i]) ** 2; a.market += (f[i] - y[i]) ** 2; a.flat += (1 / 3 - y[i]) ** 2; }
  }
  if (x.p && f && f.every(v => v != null)) {
    const t = x.p.s.H + x.p.s.D + x.p.s.A; if (!t) continue;
    const bk = [x.p.s.H / t, x.p.s.D / t, x.p.s.A / t], y = ['H', 'D', 'A'].map(o => (x.o === o ? 1 : 0)), a = br.book;
    a.n++; for (let i = 0; i < 3; i++) { a.model += (bk[i] - y[i]) ** 2; a.market += (f[i] - y[i]) ** 2; a.flat += (1 / 3 - y[i]) ** 2; }
  }
}
for (const k in br) { const a = br[k]; for (const m of ['model', 'market', 'flat']) a[m] = a.n ? Math.round(10000 * a[m] / a.n) / 10000 : null; }
paper.vsMarket = vm; paper.brier = br;

// Edge-sized stakes (quarter Kelly): Over 2.5 uses the goals model's chance, book picks use the
// ratings model's chance. Notional €1,000 bank, not compounding, max 5% (€50) per bet.
const BANK = 1000, kStake = (p, o) => Math.max(0, Math.min(0.05, 0.25 * (p * o - 1) / (o - 1))) * BANK;
paper.sized = { bank: BANK, over25: { bets: 0, won: 0, staked: 0, profit: 0 }, top3: { bets: 0, won: 0, staked: 0, profit: 0 } };
const addSized = (k, st, odd, ok) => { const a = paper.sized[k]; if (!(st > 0)) return; a.bets++; a.staked += st; if (ok) a.won++; a.profit += ok ? st * (odd - 1) : -st; };
for (const x of settledAll) if (x.g && x.g.strong) addSized('over25', kStake(x.g.p, x.g.o), x.g.o, goalHit(x));
for (const [, xs] of byDay(settledAll)) for (const c of top3(xs)) addSized('top3', kStake(c.p, c.odd), c.odd, hitTop(c, c.x));
for (const k of ['over25', 'top3']) { const a = paper.sized[k]; a.staked = Math.round(a.staked * 100) / 100; a.profit = Math.round(a.profit * 100) / 100; }
const cum = Object.fromEntries(Object.keys(MK).map(k => [k, 0]));
const days = new Map();
for (const x of settledAll.filter(x => x.od && x.p).sort((a, b) => a.ts - b.ts)) {
  for (const k in MK) {
    const m = MK[k](x), odd = m && x.od[m];
    if (!odd) continue;
    const pr = hitM(m, x.o) ? STAKE * (odd - 1) : -STAKE;
    const a = paper.markets[k]; a.bets++; if (pr > 0) a.won++; a.profit += pr; a.sq = (a.sq || 0) + (pr / STAKE) ** 2; cum[k] += pr;
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
  source: FD ? 'football-data.co.uk' : 'API-Football',
  daysCollected: FD ? new Set([...byId.values()].filter(r => r.st === 'FT').map(r => new Date(r.ts * 1000).toISOString().slice(0, 10))).size : files.length,
  firstDay: FD ? new Date(Math.min(...[...byId.values()].map(r => r.ts)) * 1000).toISOString().slice(0, 10) : files[0] ? files[0].slice(0, 10) : null,
  lastDay: FD ? new Date(Math.max(...[...byId.values()].filter(r => r.st === 'FT').map(r => r.ts)) * 1000).toISOString().slice(0, 10) : files.length ? files[files.length - 1].slice(0, 10) : null,
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

const out = path.join(ROOT, FD ? 'docs/data' : 'docs/api/data');
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
  source: FD ? { name: 'football-data.co.uk', status: FDATA.status } : { name: 'API-Football' },
  days: (FD ? [0, 1, 2, 3] : [0, 1]).map(o => dayKey(now + o * 864e2)).map(d => ({ d,
    sharp: (T3.get(d) || []).filter(x => x.ts > now).flatMap(sharpPicks).sort((a, b) => b.v - a.v).slice(0, 5)
      .map(c => ({ ts: c.x.ts, hn: c.x.hn, an: c.x.an, lg: c.x.lg, m: c.m, odd: c.odd, fair: Math.round(c.fair * 1000) / 1000, v: Math.round(c.v * 1000) / 1000, b365: c.x.od && c.x.od[c.m] || null })),
    over: overTop((T3.get(d) || []).filter(x => x.ts > now - 3 * 3600)).map(c => ({ ts: c.x.ts, hn: c.x.hn, an: c.x.an, lg: c.x.lg, p: Math.round(c.s * 1000) / 1000,
      ours: c.x.g.p, mkt: Math.round(fairProb(c.x.od, 'O2.5') * 1000) / 1000, odd: c.x.od['O2.5'], best: bestOf(c.x, 'O2.5'), started: c.x.ts <= now })),
    picks: top3(T3.get(d) || []).map(c => ({
    ts: c.x.ts, hn: c.x.hn, an: c.x.an, lg: c.x.lg, m: c.m, kind: c.kind, odd: c.odd, why: c.why, p: c.p, started: c.x.ts <= now,
    best: bestOf(c.x, c.m), nb: c.x.nb || null,
  })) })),
});
// Shortlist for line shopping (scripts/shop.js): the top 6 candidates of today and tomorrow
// that have not kicked off, at most 10 matches.
const shop = [];
for (const o of [0, 1]) for (const c of top3((T3.get(dayKey(now + o * 864e2)) || []).filter(x => x.ts > now + 600), 6)) if (shop.length < 10) shop.push(c.x.id);
if (!FD) writeJSON(path.join(ROOT, 'data/shop.json'), { at: new Date().toISOString(), ids: shop });
console.log(`days=${files.length} fixtures=${byId.size} teamsReady=${ready}/${hist.size} upcoming=${upcoming.length} (predicted ${S.meta.upcomingPredicted}) graded=${S.graded}`);
