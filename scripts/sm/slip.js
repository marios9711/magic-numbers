// Daily slip from the Sportmonks price record (no API calls; runs after odds.js).
//
// For every selection on offer: chance = Pinnacle's margin-free chance when Pinnacle prices it
// (else the median of all bookmakers' margin-free chances), edge = best price x chance - 1,
// move = how far that chance has moved since we first saw the match (money coming in or out).
//
// Daily slip (three markets only): home/away win (no draw), over 2.5 goals, and over 1.5 goals in
// the 1st half. Per day up to 4 picks in each of the three markets, one pick per match (ever),
// kick-off within 36 h, odds 1.40–5.00, edge >= 2% against Pinnacle or >= 4% against the
// consensus, 4+ bookmakers pricing it, the chance not moving against it by 3+ points, and not in
// the famous leagues (they are still recorded as a yardstick). Late in the season the table
// matters: motivation rules (scripts/sm/motivation.js) add to or block a selection.
// Picks are logged the first time they appear and never changed afterwards.
// Scored by: beating the later price (odds taken x later fair chance - 1) and paper profit at €10.
const S = require('./smlib');
const Model = require('./model');
const Mot = require('./motivation');
const Squad = require('./squad');

const CFG = {
  keys: { 1: 'win', 2: 'win', 'O2.5': 'over25', 'HO1.5': 'ht15' },
  caps: { win: 4, over25: 4, ht15: 4 },
  windowH: 36, minLeadMin: 30, minOdds: 1.4, maxOdds: 5, minEdgePin: 0.02, minEdgeCons: 0.04,
  minBooks: 4, maxAgainst: 0.03, skipFamous: true,
  stake: 10, tz: 'Europe/Bucharest',
};
const localDay = ts => new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: CFG.tz });
const last = a => (a && a.length ? a[a.length - 1] : null);
const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);
const GROUP_NAME = { win: 'Win (home or away)', over25: 'Over 2.5 goals', ht15: 'Over 1.5 goals, 1st half' };
// Famous leagues: recorded and shown, but kept off the slip (the focus is where fewer people look).
const FAMOUS_LIST = [
  ['england', 'premier league'], ['spain', 'la liga'], ['italy', 'serie a'], ['germany', 'bundesliga'],
  ['france', 'ligue 1'], ['netherlands', 'eredivisie'], ['portugal', 'liga portugal'], ['portugal', 'primeira liga'],
];
const isFamous = L => !!L && (/champions league|europa league|conference league/i.test(L.name || '')
  || FAMOUS_LIST.some(([c, n]) => (L.country || '').toLowerCase() === c && (L.name || '').toLowerCase() === n));

(async () => {
  if (!S.needKey('slip.js')) return;
  const st = S.loadState();
  const nowS = S.now(), tm = Math.floor(nowS / 60), today = localDay(nowS);
  const books = st.books;

  // Price records: kick-off dates from 5 days ago to 8 days ahead.
  // A match moved to another date can sit in two files: keep the most recently priced copy.
  const byFid = new Map();
  for (let d = -5; d <= 8; d++) {
    const date = new Date((nowS + d * 86400) * 1000).toISOString().slice(0, 10);
    for (const r of Object.values(S.readJSON(S.p(`odds/${date}.json`), {}))) {
      const old = byFid.get(r.id);
      if (!old || (last(r.snaps) || 0) > (last(old.snaps) || 0)) byFid.set(r.id, r);
    }
  }
  const recs = [...byFid.values()];

  // Results: the current season of every league with a recorded match.
  const leaguesUsed = new Set(recs.map(r => r.lg));
  const seasonsByLeague = {};
  for (const [sid, lg] of Object.entries(st.seasonLeague)) (seasonsByLeague[lg] = seasonsByLeague[lg] || []).push(sid);
  const result = {}, rowsByLeague = {}, stand = {};
  for (const lg of leaguesUsed) {
    const rows = [], bySeason = {};
    for (const sid of seasonsByLeague[lg] || []) { bySeason[sid] = S.readJSON(S.p(`seasons/${sid}.json`), { m: [] }).m; rows.push(...bySeason[sid]); }
    rowsByLeague[lg] = rows;
    for (const r of rows) result[r[0]] = [r[4], r[5], r[6], r[7]];
    // Motivation: the league's current season (and the previous one for the season length).
    const L = st.leagues[lg];
    const isCup = L && (/cup/i.test(L.type || '') || /cup|pokal|coppa|copa|coupe|taça|beker/i.test(L.name || ''));
    if (L && !isCup && L.seasons && L.seasons.length) {
      stand[lg] = Mot.standings(bySeason[L.seasons[0]] || [], bySeason[L.seasons[1]] || [], nowS);
    }
  }
  const fits = {};
  const modelFor = rec => {
    if (!(rec.lg in fits)) fits[rec.lg] = Model.fit(rowsByLeague[rec.lg] || [], nowS);
    return Model.matrix(fits[rec.lg], rec.h, rec.a);
  };

  // Current view of every selection.
  const sel = [];
  for (const rec of recs) {
    const lastSnap = last(rec.snaps);
    const sd = stand[rec.lg], th = sd ? sd.stateOf(String(rec.h)) : 'early', ta = sd ? sd.stateOf(String(rec.a)) : 'early';
    let mx;
    for (const [key, o] of Object.entries(rec.o || {})) {
      const b = last(o.b);
      if (!b) continue;
      const pinNow = o.pfAt === lastSnap && o.pf.length;
      const series = pinNow ? o.pf : o.cf;
      const fair = last(series) && last(series)[1];
      if (!fair) continue;
      if (mx === undefined) mx = modelFor(rec);
      const firstB = o.b[0];
      const rules = CFG.keys[key] ? Mot.rulesFor(th, ta, key) : [];
      const boost = rules.reduce((s, r) => s + (r.boost || 0), 0);
      sel.push({
        fid: rec.id, lg: rec.lg, ts: rec.ts, hn: rec.hn, an: rec.an, key, mk: S.marketOf(key), grp: CFG.keys[key] || null,
        odds: b[1], book: books[b[2]] || `#${b[2]}`, ref: pinNow ? 'pin' : 'cons', fair,
        edge: b[1] * (fair + boost) - 1, edgeMkt: b[1] * fair - 1, boost, block: rules.some(r => r.block),
        rules: rules.map(r => r.id), mot: [th, ta], famous: isFamous(st.leagues[rec.lg]),
        move: fair - series[0][1], open: firstB[1], n: o.n,
        live: o.at === lastSnap, model: Model.prob(mx, key), pin: last(o.pf) && o.pfAt === lastSnap ? last(o.pf)[1] : null,
      });
    }
  }

  // --- the pick log ---------------------------------------------------------------------------
  const log = S.readJSON(S.p('picks.json'), { picks: [] });
  const have = new Set(log.picks.map(x => x.id));
  // One pick per match, ever: a match seen again on a later day (or the other side of it) is skipped.
  const usedFixtures = new Set(log.picks.map(x => x.fid));
  const count = {};
  for (const x of log.picks) if (x.day === today) count[x.grp] = (count[x.grp] || 0) + 1;
  const ok = x => x.live && x.grp && !x.block && !(CFG.skipFamous && x.famous)
    && x.ts > nowS + CFG.minLeadMin * 60 && x.ts < nowS + CFG.windowH * 3600
    && x.odds >= CFG.minOdds && x.odds <= CFG.maxOdds && x.n >= CFG.minBooks
    && x.edge >= (x.ref === 'pin' ? CFG.minEdgePin : CFG.minEdgeCons) && x.move > -CFG.maxAgainst;
  const cands = sel.filter(ok).sort((a, b) => b.edge - a.edge);
  const fresh = [];
  for (const c of cands) {
    if ((count[c.grp] || 0) >= CFG.caps[c.grp]) continue;
    const id = `${c.fid}:${c.key}`;
    if (have.has(id) || usedFixtures.has(c.fid)) continue;
    log.picks.push({
      id, day: today, at: nowS, fid: c.fid, lg: c.lg, ts: c.ts, hn: c.hn, an: c.an, key: c.key, mk: c.mk, grp: c.grp,
      odds: c.odds, book: c.book, ref: c.ref, fair0: r3(c.fair), edge0: r3(c.edge), edgeMkt: r3(c.edgeMkt), boost: c.boost || undefined,
      rules: c.rules.length ? c.rules : undefined, mot: c.mot, move0: r3(c.move), model: r3(c.model), n: c.n,
    });
    have.add(id); usedFixtures.add(c.fid); count[c.grp] = (count[c.grp] || 0) + 1;
    fresh.push(log.picks[log.picks.length - 1]);
  }
  // Injuries/suspensions of key scorers for the new picks (a warning only; the pick stays).
  for (const pk of fresh) {
    try { const q = await Squad.check(pk); if (q) { pk.out = q.out.length ? q.out : undefined; pk.warn = q.warn || undefined; pk.squad = 1; } }
    catch (e) { console.log('squad check failed', pk.id, e.message); }
  }
  // Later price (until kick-off) and result.
  const byId = new Map(sel.map(x => [`${x.fid}:${x.key}`, x]));
  for (const pk of log.picks) {
    const cur = byId.get(pk.id);
    if (cur && nowS < pk.ts) {
      // compare like with like: a Pinnacle pick is checked against Pinnacle's later chance
      const fl = pk.ref === 'pin' ? cur.pin : cur.fair;
      if (fl != null) { pk.fairL = r3(fl); pk.clv = r3(pk.odds * fl - 1); pk.oddsL = cur.odds; }
    }
    const res = result[pk.fid];
    if (res && pk.r == null) {
      const r = S.settle(pk.key, res[0], res[1], res[2], res[3]);
      if (r != null) { // a 1st-half pick waits until the half-time score is known
        pk.score = `${res[0]}-${res[1]}` + (res[2] != null ? ` (HT ${res[2]}-${res[3]})` : '');
        pk.r = r;
        pk.profit = Math.round(S.payoff(pk.r, pk.odds) * CFG.stake * 100) / 100;
      }
    }
  }
  log.picks = log.picks.filter(x => x.ts > nowS - 180 * 86400);
  S.writeJSON(S.p('picks.json'), log);

  // --- model check: the model's 1X2 chances vs the market's, frozen before kick-off ----------
  const ml = S.readJSON(S.p('modellog.json'), {});
  for (const rec of recs) {
    if (!rec.o || !rec.o['1'] || !rec.o.X || !rec.o['2']) continue;
    const e = ml[rec.id] = ml[rec.id] || { ts: rec.ts, lg: rec.lg };
    if (nowS < rec.ts) {
      if (!e.m) { const mx = modelFor(rec); if (mx) e.m = ['1', 'X', '2'].map(k => r3(Model.prob(mx, k))); }
      const lv = k => last(rec.o[k].cf) && last(rec.o[k].cf)[1];
      e.c = ['1', 'X', '2'].map(lv).map(r3);
      const pv = ['1', 'X', '2'].map(k => last(rec.o[k].pf) && last(rec.o[k].pf)[1]);
      if (pv.every(x => x)) e.p = pv.map(r3);
    }
    if (result[rec.id]) { const [h, a] = result[rec.id]; e.o = h > a ? 0 : h === a ? 1 : 2; }
  }
  for (const [id, e] of Object.entries(ml)) if (e.ts < nowS - 120 * 86400) delete ml[id];
  S.writeJSON(S.p('modellog.json'), ml);
  const check = { n: 0, model: 0, cons: 0, pin: 0, nPin: 0, modelPin: 0 };
  for (const e of Object.values(ml)) {
    if (e.o == null || !e.m || !e.c || e.m.some(x => !x) || e.c.some(x => !x)) continue;
    check.n++; check.model -= Math.log(e.m[e.o]); check.cons -= Math.log(e.c[e.o]);
    if (e.p) { check.nPin++; check.pin -= Math.log(e.p[e.o]); check.modelPin -= Math.log(e.m[e.o]); }
  }
  const avg = (s, n) => (n ? Math.round(s / n * 1e4) / 1e4 : null);
  const modelCheck = {
    n: check.n, model: avg(check.model, check.n), consensus: avg(check.cons, check.n),
    nPin: check.nPin, modelVsPin: avg(check.modelPin, check.nPin), pinnacle: avg(check.pin, check.nPin),
  };

  // --- page data ------------------------------------------------------------------------------
  const lgName = id => { const L = st.leagues[id]; return L ? `${L.country ? L.country + ' – ' : ''}${L.name}` : `League ${id}`; };
  const motText = m => (m && (m[0] !== 'early' || m[1] !== 'early'))
    ? [m[0] !== 'early' && `home ${Mot.words[m[0]]}`, m[1] !== 'early' && `away ${Mot.words[m[1]]}`].filter(Boolean).join(', ') : null;
  const ruleText = ids => (ids || []).map(id => (Mot.RULES.find(r => r.id === id) || {}).text).filter(Boolean);
  const view = x => ({
    fid: x.fid, lg: lgName(x.lg), ts: x.ts, hn: x.hn, an: x.an, key: x.key, mk: x.mk, grp: x.grp, pick: S.label(x.key, x.hn, x.an),
    odds: x.odds, book: x.book, ref: x.ref, fair: r3(x.fair), edge: r3(x.edge), boost: x.boost || 0, move: r3(x.move), open: x.open,
    n: x.n, model: r3(x.model), famous: x.famous, motText: motText(x.mot), why: ruleText(x.rules), block: x.block,
  });
  const pickView = pk => ({ ...pk, lg: lgName(pk.lg), pick: S.label(pk.key, pk.hn, pk.an), motText: motText(pk.mot), why: ruleText(pk.rules) });
  const upcomingSel = sel.filter(x => x.live && x.ts > nowS && x.grp);
  const value = upcomingSel.filter(x => x.edge > 0 && x.odds >= 1.2 && x.odds <= 10 && x.n >= 3)
    .sort((a, b) => b.edge - a.edge).slice(0, 150).map(view);
  const movers = upcomingSel.filter(x => x.move >= 0.03)
    .sort((a, b) => b.move - a.move).slice(0, 40).map(view);
  const settled = log.picks.filter(x => x.r != null), withClv = log.picks.filter(x => x.clv != null);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const perf = {
    logged: log.picks.length, settled: settled.length, won: settled.filter(x => x.r > 0).length,
    profit: Math.round(sum(settled, x => x.profit) * 100) / 100,
    roi: settled.length ? r3(sum(settled, x => x.profit) / (settled.length * CFG.stake)) : null,
    clvN: withClv.length, clvAvg: withClv.length ? r3(sum(withClv, x => x.clv) / withClv.length) : null,
    clvPos: withClv.length ? r3(withClv.filter(x => x.clv > 0).length / withClv.length) : null,
    byMarket: Object.fromEntries(Object.keys(CFG.caps).map(g => {
      const s = settled.filter(x => x.grp === g);
      return [GROUP_NAME[g], { n: s.length, won: s.filter(x => x.r > 0).length, profit: Math.round(sum(s, x => x.profit) * 100) / 100 }];
    })),
    byRule: Object.fromEntries([['with a motivation rule', x => x.rules], ['no motivation rule', x => !x.rules]].map(([name, f]) => {
      const s = settled.filter(f), c = withClv.filter(f);
      return [name, { n: s.length, profit: Math.round(sum(s, x => x.profit) * 100) / 100, clvN: c.length,
        clvPos: c.length ? r3(c.filter(x => x.clv > 0).length / c.length) : null }];
    })),
  };
  const fixturesTracked = recs.filter(r => r.ts > nowS).length;
  const out = {
    at: new Date(Date.now()).toISOString(), today,
    slip: log.picks.filter(x => x.day === today).map(pickView),
    history: log.picks.filter(x => x.day !== today).sort((a, b) => b.at - a.at).slice(0, 150).map(pickView),
    value, movers, perf, modelCheck, settings: { ...CFG, groupNames: GROUP_NAME }, rules: Mot.RULES.map(r => ({ id: r.id, key: r.key, boost: r.boost, block: !!r.block, text: r.text })),
    status: {
      leagues: Object.keys(st.leagues).length, seasonsLeft: Object.values(st.hist).filter(h => !h.done).length,
      seasons: Object.keys(st.hist).length, fixturesTracked, selections: upcomingSel.length,
      withPinnacle: new Set(upcomingSel.filter(x => x.ref === 'pin').map(x => x.fid)).size,
      books: Object.keys(books).length, runs: st.log.slice(0, 12),
    },
  };
  S.writeJSON(S.p('../../docs/data/sm/slip.json'), out);
  console.log('slip.js', JSON.stringify({ today: out.slip.length, value: value.length, movers: movers.length, tracked: fixturesTracked, perf }));
})().catch(e => { console.error('slip.js failed:', e.message); process.exitCode = 1; });
