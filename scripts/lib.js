// Shared helpers: API access, compact fixture format, form history, evaluation.
const fs = require('fs');
const path = require('path');
const Engine = require('../docs/engine.js');

const ROOT = path.join(__dirname, '..');
const API = 'https://v3.football.api-sports.io';
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const DEAD = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);

async function api(endpoint) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new Error('APIFOOTBALL_KEY secret is not set');
  const res = await fetch(API + endpoint, { headers: { 'x-apisports-key': key } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error(`API error for ${endpoint}: ${errs.join('; ')}`);
  return j.response || [];
}

// Compact row: one fixture.
function compact(f) {
  const ft = f.score && f.score.fulltime;
  const hg = ft && ft.home != null ? ft.home : f.goals.home;
  const ag = ft && ft.away != null ? ft.away : f.goals.away;
  return {
    id: f.fixture.id,
    ts: f.fixture.timestamp,
    st: f.fixture.status.short,
    lg: f.league.id,
    ln: f.league.name,
    lc: f.league.country,
    h: f.teams.home.id,
    hn: f.teams.home.name,
    a: f.teams.away.id,
    an: f.teams.away.name,
    hg, ag,
  };
}

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

const isFriendly = r => /friendl/i.test(r.ln || '');
const outcomeOf = r => (r.hg > r.ag ? 'H' : r.hg < r.ag ? 'A' : 'D');

// Walk fixtures in time order; predict each from history strictly before its kick-off.
// Returns list of {row, pred, outcome|null}.
function evaluate(rows, { excludeFriendlies = true } = {}) {
  const list = rows.filter(r => !(excludeFriendlies && isFriendly(r)) && !DEAD.has(r.st))
    .sort((x, y) => x.ts - y.ts || x.id - y.id);
  const hist = new Map(); // teamId -> [{r, home, ts}]
  const get = id => { if (!hist.has(id)) hist.set(id, []); return hist.get(id); };
  const out = [];
  let i = 0;
  while (i < list.length) {
    // group fixtures with the same kick-off so none sees another's result
    let j = i; while (j < list.length && list[j].ts === list[i].ts) j++;
    const group = list.slice(i, j);
    for (const r of group) {
      const pred = Engine.predict(get(r.h).slice(-8), get(r.a).slice(-8));
      const done = FINISHED.has(r.st) && r.hg != null;
      out.push({ row: r, pred, outcome: done ? outcomeOf(r) : null });
    }
    for (const r of group) {
      if (!(FINISHED.has(r.st) && r.hg != null)) continue;
      const o = outcomeOf(r);
      get(r.h).push({ r: o === 'H' ? 'W' : o === 'D' ? 'D' : 'L', home: true, ts: r.ts });
      get(r.a).push({ r: o === 'A' ? 'W' : o === 'D' ? 'D' : 'L', home: false, ts: r.ts });
    }
    i = j;
  }
  return { results: out, hist };
}

// Aggregate hit rates for the method and baselines over graded predictions.
function stats(results) {
  const g = results.filter(x => x.pred && x.outcome);
  const acc = () => ({ n: 0, hit: 0 });
  const bump = (a, ok) => { a.n++; if (ok) a.hit++; };
  const S = {
    graded: g.length,
    pick: acc(), doubleChance: acc(), underdog: acc(),
    baseHome: acc(), baseFormFav: acc(), baseHomeOrDraw: acc(),
    outcomes: { H: 0, D: 0, A: 0 },
    byConfidence: {}, byRule: {}, byLeague: {},
  };
  for (const x of g) {
    const p = x.pred, o = x.outcome;
    S.outcomes[o]++;
    bump(S.pick, Engine.hit(p.pickLabel, o));
    bump(S.doubleChance, Engine.hit(p.doubleChance, o));
    if (p.underdog) bump(S.underdog, Engine.hit(p.underdog, o));
    bump(S.baseHome, o === 'H');
    bump(S.baseHomeOrDraw, o !== 'A');
    const fh = pts(p.forms.h.f7), fa = pts(p.forms.a.f7);
    bump(S.baseFormFav, o === (fa > fh ? 'A' : 'H'));
    const c = (S.byConfidence[p.confidence] ||= acc()); bump(c, Engine.hit(p.pickLabel, o));
    for (const r of p.rules) {
      const best = Object.keys(r.w).sort((a, b) => r.w[b] - r.w[a]);
      const mk = best.length > 1 ? dcOf(best[0], best[1]) : lbl(best[0]);
      const k = (S.byRule[r.id] ||= { n: 0, hit: 0, market: {} });
      k.n++; if (Engine.hit(mk, o)) k.hit++;
    }
    const lk = `${x.row.lc} – ${x.row.ln}`;
    const l = (S.byLeague[lk] ||= { n: 0, hit: 0, dc: 0, ud: 0, udHit: 0 });
    l.n++; if (Engine.hit(p.pickLabel, o)) l.hit++; if (Engine.hit(p.doubleChance, o)) l.dc++;
    if (p.underdog) { l.ud++; if (Engine.hit(p.underdog, o)) l.udHit++; }
  }
  for (const k in S.byRule) delete S.byRule[k].market;
  return S;
}
const pts = f => { const [w, d] = f.split('-').map(Number); return 3 * w + d; };
const lbl = o => (o === 'H' ? '1' : o === 'D' ? 'X' : '2');
function dcOf(a, b) { const s = [a, b].sort((x, y) => 'HDA'.indexOf(x) - 'HDA'.indexOf(y)).join(''); return s === 'HD' ? '1X' : s === 'DA' ? 'X2' : '12'; }

// Slim record for the website.
function slim(x) {
  const r = x.row, p = x.pred;
  return {
    id: r.id, ts: r.ts, st: r.st, lg: `${r.lc} – ${r.ln}`, hn: r.hn, an: r.an, hg: r.hg, ag: r.ag,
    o: x.outcome,
    p: p && {
      pick: p.pickLabel, conf: p.confidence, dc: p.doubleChance, ud: p.underdog,
      s: Object.fromEntries(Object.entries(p.scores).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      f: p.forms, why: p.rules.map(q => q.text),
    },
  };
}

module.exports = { ROOT, api, compact, readJSON, writeJSON, evaluate, stats, slim, FINISHED, Engine };
