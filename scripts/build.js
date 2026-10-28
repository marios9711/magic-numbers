// Builds the website data from all collected days.
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON, writeJSON, evaluate, stats, slim } = require('./lib');

const dir = path.join(ROOT, 'data/days');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const byId = new Map();
for (const f of files) for (const r of readJSON(path.join(dir, f), { rows: [] }).rows) byId.set(r.id, r); // newer files win

const { results, hist } = evaluate([...byId.values()]);
const now = Date.now() / 1000;

const odds = readJSON(path.join(ROOT, 'data/odds.json'), {});
const withOdds = x => { const o = odds[x.id]; if (o && o.m && Object.keys(o.m).length) { x.od = o.m; x.bm = o.bm; } return x; };
const upcoming = results
  .filter(x => !x.outcome && x.row.ts > now - 3 * 3600 && x.row.ts < now + 2 * 864e2)
  .map(slim).map(withOdds);
const settledAll = results.filter(x => x.outcome && x.pred).map(slim).map(withOdds);
const settled = settledAll.slice().reverse().slice(0, 1000);

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
const cum = Object.fromEntries(Object.keys(MK).map(k => [k, 0]));
const days = new Map();
for (const x of settledAll.filter(x => x.od).sort((a, b) => a.ts - b.ts)) {
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
console.log(`days=${files.length} fixtures=${byId.size} teamsReady=${ready}/${hist.size} upcoming=${upcoming.length} (predicted ${S.meta.upcomingPredicted}) graded=${S.graded}`);
