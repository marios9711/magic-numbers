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

const upcoming = results
  .filter(x => !x.outcome && x.row.ts > now - 3 * 3600 && x.row.ts < now + 2 * 864e2)
  .map(slim);
const settled = results.filter(x => x.outcome && x.pred).map(slim).reverse().slice(0, 1000);

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
