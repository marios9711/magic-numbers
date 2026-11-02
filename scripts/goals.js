// Over 2.5 goals model (not from the book). Fitted on the 2022–23 backtest seasons,
// checked on 2024: of matches with a 60%+ chance that also pass both "signs", 63.6% went Over 2.5.
// Inputs: each team's goals for/against over its last 6 matches and the league's
// running average goals (last 200 matches). Only matches before kick-off are used.
const fs = require('fs');
const path = require('path');
const { ROOT, readJSON, FINISHED } = require('./lib');

const W = { hFor: 0.2027, hAg: -0.0143, aFor: 0.0708, aAg: 0.0805, lg: 0.6561, b: -2.1726 };
const RULES = {
  minProb: 0.60,     // our chance of 3+ goals
  minXg: 3.0,        // both teams' average goals per game (scored + conceded), combined
  minOvers: 7,       // of the two teams' last 12 games together
  minOdds: 1.80,     // Marios's rule: a strong selection needs odds of 1.80 or more
  maxOdds: 2.50,     // longer prices mean the bookmaker strongly disagrees
  minEdge: 1.05,     // chance x odds
  maxMargin: 0.08,   // bookmaker margin on Over/Under 2.5
};
const CUP = /cup|copa|coupe|pokal|coppa|ta[cç]a|beker|trophy|shield|super ?cup|friendl/i;
const DEAD = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);

// League goal history seeded from the latest cached backtest season, so the
// 42 backtest leagues have an average straight away.
function seedLeagues() {
  const dir = path.join(ROOT, 'data/seasons'), latest = {};
  if (!fs.existsSync(dir)) return new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)-(\d+)\.json$/.exec(f); if (!m) continue;
    if (!latest[m[1]] || latest[m[1]] < m[2]) latest[m[1]] = m[2];
  }
  const out = new Map();
  for (const [lg, s] of Object.entries(latest)) {
    const rows = readJSON(path.join(dir, `${lg}-${s}.json`), { rows: [] }).rows
      .filter(r => FINISHED.has(r.st) && r.hg != null).sort((a, b) => a.ts - b.ts);
    out.set(Number(lg), rows.slice(-200).map(r => r.hg + r.ag));
  }
  return out;
}

// Walk all fixtures in kick-off order; returns Map fixtureId -> goals info.
function goalsModel(rows, { seed = true } = {}) {
  const list = rows.filter(r => !/friendl/i.test(r.ln || '') && !DEAD.has(r.st)).sort((a, b) => a.ts - b.ts || a.id - b.id);
  const team = new Map(), league = seed ? seedLeagues() : new Map(), out = new Map();
  const T = id => { if (!team.has(id)) team.set(id, []); return team.get(id); };
  const L = id => { if (!league.has(id)) league.set(id, []); return league.get(id); };
  let i = 0;
  while (i < list.length) {
    let j = i; while (j < list.length && list[j].ts === list[i].ts) j++;
    const group = list.slice(i, j);
    for (const r of group) {
      const H = T(r.h).slice(-6), A = T(r.a).slice(-6), lg = L(r.lg).slice(-200);
      if (H.length < 6 || A.length < 6 || lg.length < 30) { out.set(r.id, null); continue; }
      const avg = (x, k) => x.reduce((s, g) => s + g[k], 0) / x.length;
      const f = { hFor: avg(H, 0), hAg: avg(H, 1), aFor: avg(A, 0), aAg: avg(A, 1), lg: lg.reduce((s, g) => s + g, 0) / lg.length };
      const z = W.b + W.hFor * f.hFor + W.hAg * f.hAg + W.aFor * f.aFor + W.aAg * f.aAg + W.lg * f.lg;
      out.set(r.id, {
        p: 1 / (1 + Math.exp(-z)),
        xg: (f.hFor + f.hAg + f.aFor + f.aAg) / 2,
        ov: [...H, ...A].filter(g => g[0] + g[1] > 2).length,
        lg: f.lg, cup: CUP.test(r.ln || ''),
      });
    }
    for (const r of group) {
      if (!(FINISHED.has(r.st) && r.hg != null)) continue;
      T(r.h).push([r.hg, r.ag]); T(r.a).push([r.ag, r.hg]); L(r.lg).push(r.hg + r.ag);
    }
    i = j;
  }
  return out;
}

// Decide whether a match is a strong Over 2.5 selection. Returns the slim object for the site.
function judge(g, od) {
  if (!g) return null;
  const R = RULES, o = od && od['O2.5'], u = od && od['U2.5'];
  const margin = o && u ? 1 / o + 1 / u - 1 : null;
  const checks = [
    [g.p >= R.minProb, `chance ${(g.p * 100).toFixed(0)}% (need ${R.minProb * 100}%+)`],
    [g.xg >= R.minXg, `goals per game ${g.xg.toFixed(2)} (need ${R.minXg.toFixed(1)}+)`],
    [g.ov >= R.minOvers, `${g.ov} of last 12 games Over (need ${R.minOvers}+)`],
    [!!o && o >= R.minOdds && o <= R.maxOdds, o ? `odds ${o.toFixed(2)} (need ${R.minOdds.toFixed(2)}–${R.maxOdds.toFixed(2)})` : 'no Over 2.5 odds yet'],
    [!!o && g.p * o >= R.minEdge, o ? `value ${(g.p * o).toFixed(2)} (need ${R.minEdge}+)` : 'value unknown'],
    [margin != null && margin <= R.maxMargin, margin != null ? `bookmaker margin ${(margin * 100).toFixed(1)}% (need ≤${R.maxMargin * 100}%)` : 'margin unknown'],
    [!g.cup, g.cup ? 'cup match (rotation risk)' : 'league match'],
  ];
  const fp = fairProb(od, 'O2.5');
  return {
    fair: fp != null ? Math.round(fp * 1000) / 1000 : null,
    p: Math.round(g.p * 1000) / 1000, xg: Math.round(g.xg * 100) / 100, ov: g.ov, lg: Math.round(g.lg * 100) / 100,
    o: o || null, strong: checks.every(c => c[0]), edge: o ? Math.round((g.p * o - 1) * 1000) / 1000 : null,
    fail: checks.filter(c => !c[0]).map(c => c[1]), pass: checks.filter(c => c[0]).map(c => c[1]),
  };
}

// Bookmaker's own chance for a selection, with its margin removed (1X2 or Over/Under 2.5 group).
const GROUPS = [['1', 'X', '2'], ['O2.5', 'U2.5'], ['O1.5', 'U1.5'], ['O3.5', 'U3.5']];
function fairProb(m, key) {
  const g = m && GROUPS.find(g => g.includes(key));
  if (!g || !g.every(k => m[k] > 1)) return null;
  return (1 / m[key]) / g.reduce((s, k) => s + 1 / m[k], 0);
}

module.exports = { goalsModel, judge, RULES, fairProb };
