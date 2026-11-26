// API-Football: every fixture from 3 days ago to 2 days ahead (one call per date).
//  - finished ones go into the season files (results for the model and for grading picks)
//  - upcoming ones go to data/af/upcoming.json (odds.js matches its prices to these)
//  - leagues seen are added to state.leagues; history.js then downloads their past seasons
const S = require('../sm/smlib');
const A = require('./aflib');

const BACK_DAYS = 3, AHEAD_DAYS = 2;

(async () => {
  if (!S.needKey('af/results.js')) return;
  const st = S.loadState();
  const d = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const rows = [];
  for (let n = -BACK_DAYS; n <= AHEAD_DAYS; n++) {
    try { rows.push(...((await A.get('/fixtures', { date: d(n) })).response || [])); }
    catch (e) { if (e.rateLimited) throw e; console.log('fixtures', d(n), 'failed:', e.message); }
  }
  const keep = rows.filter(f => !A.SKIP_LEAGUE.test(f.league.name || ''));
  for (const f of keep) {
    const L = st.leagues[f.league.id] = st.leagues[f.league.id] || { name: f.league.name, country: f.league.country || '', type: '', seasons: [] };
    const sid = A.sidOf(f.league.id, f.league.season);
    if (!L.seasons.includes(sid)) {
      L.seasons.push(sid);
      L.seasons.sort((x, y) => Number(y.split('-')[1]) - Number(x.split('-')[1])); // newest first
    }
    L.current = L.seasons[0];
    st.seasonLeague[sid] = f.league.id;
  }
  const fx = keep.map(A.compactFixture).filter(f => f.h && f.a);
  const added = S.addResults(fx, st);
  const t = S.now();
  const upcoming = fx.filter(f => f.ts > t - 3 * 3600 && f.hg == null && !A.DEAD.test(f.st))
    .map(({ id, lg, sid, ts, st: state, h, a, hn, an }) => ({ id, lg, sid, ts, st: state, h, a, hn, an }))
    .sort((x, y) => x.ts - y.ts);
  S.writeJSON(S.p('upcoming.json'), { at: new Date(Date.now()).toISOString(), fixtures: upcoming });
  const log = { job: 'results', fixtures: rows.length, kept: fx.length, newResults: added, upcoming: upcoming.length, calls: A.callCount(), left: A.remaining() };
  S.saveState(st, log);
  console.log('af/results.js', JSON.stringify(log));
})().catch(e => { console.error('af/results.js failed:', e.message); process.exitCode = 1; });
