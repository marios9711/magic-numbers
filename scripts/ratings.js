// Opponent-adjusted team ratings (not from the book). Each team has an attack and a defence
// rating; each league has a base scoring rate and a home advantage. Expected goals:
//   home = exp(base + homeAdv + attack(home) - defence(away)),  away = exp(base + attack(away) - defence(home))
// After every match the ratings move towards what happened (k = 0.02) and shrink 1% towards
// average. Poisson scorelines turn expected goals into 1/X/2 and Over 2.5 chances.
// Backtest (train 2022–23, test 2024): 1X2 pick 48.4% correct (book 28.6%, always home 44.1%).
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON, FINISHED } = require('./lib');

const K = 0.02, KC = 0.01, SHRINK = 0.01, MIN = 6;
const DEAD = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);
const fact = [1]; for (let i = 1; i <= 10; i++) fact[i] = fact[i - 1] * i;
const pois = (l, g) => Math.exp(-l) * l ** g / fact[g];

function probs(lh, la) {
  let H = 0, D = 0, A = 0, u2 = 0, tot = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(lh, i) * pois(la, j); tot += p;
    if (i > j) H += p; else if (i === j) D += p; else A += p;
    if (i + j <= 2) u2 += p;
  }
  return { H: H / tot, D: D / tot, A: A / tot, over: 1 - u2 / tot };
}

// Walk fixtures in kick-off order, predicting each before its result is added.
function walk(list, league, team, out) {
  const L = id => { if (!league.has(id)) league.set(id, { c: Math.log(1.3), ha: 0.2 }); return league.get(id); };
  const T = id => { if (!team.has(id)) team.set(id, { att: 0, def: 0, n: 0 }); return team.get(id); };
  let i = 0;
  while (i < list.length) {
    let j = i; while (j < list.length && list[j].ts === list[i].ts) j++;
    const group = list.slice(i, j);
    if (out) for (const r of group) {
      const lg = L(r.lg), h = T(r.h), a = T(r.a);
      if (h.n < MIN || a.n < MIN) { out.set(r.id, null); continue; }
      const lh = Math.exp(lg.c + lg.ha + h.att - a.def), la = Math.exp(lg.c + a.att - h.def);
      out.set(r.id, { lh, la, ...probs(lh, la) });
    }
    for (const r of group) {
      if (!(FINISHED.has(r.st) && r.hg != null)) continue;
      const lg = L(r.lg), h = T(r.h), a = T(r.a);
      const eh = r.hg - Math.exp(lg.c + lg.ha + h.att - a.def), ea = r.ag - Math.exp(lg.c + a.att - h.def);
      h.att += K * eh; a.def -= K * eh; a.att += K * ea; h.def -= K * ea;
      for (const t of [h, a]) { t.att *= 1 - SHRINK; t.def *= 1 - SHRINK; t.n++; }
      lg.c += KC * (eh + ea) / 2; lg.ha += KC * (eh - ea) / 2;
    }
    i = j;
  }
}

const clean = rows => rows.filter(r => !/friendl/i.test(r.ln || '') && !DEAD.has(r.st)).sort((a, b) => a.ts - b.ts || a.id - b.id);

// League base rates and home advantage are warmed up on the latest cached backtest season;
// team ratings always start fresh from the collected matches.
function seedLeagues() {
  const dir = path.join(ROOT, 'data/seasons'), latest = {}, league = new Map();
  if (!fs.existsSync(dir)) return league;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)-(\d+)\.json$/.exec(f); if (!m) continue;
    if (!latest[m[1]] || latest[m[1]] < m[2]) latest[m[1]] = m[2];
  }
  for (const [lg, s] of Object.entries(latest)) walk(clean(readJSON(path.join(dir, `${lg}-${s}.json`), { rows: [] }).rows), league, new Map(), null);
  return league;
}

function ratingsModel(rows, { seed = true } = {}) {
  const out = new Map();
  walk(clean(rows), seed ? seedLeagues() : new Map(), new Map(), out);
  return out;
}

module.exports = { ratingsModel, probs };
