// API-Football: bookmaker names, league types, and past seasons' results.
// Only leagues with pre-match odds (seen by odds.js) are downloaded: the current season + 2 earlier
// ones, one call per league-season. Finished seasons are done for good; the current season is
// downloaded once and then kept up to date by results.js. At most MAX_CALLS per run (the rest next run).
const S = require('../sm/smlib');
const A = require('./aflib');

const PAST_SEASONS = 2;
const MAX_CALLS = Number(process.env.HIST_MAX_CALLS || 250);
// Pre-match bet ids in API-Football -> the market names used by odds.js / slip.js
const MARKETS = { '1X2': 1, AH: 4, OU: 5, HOU: 6, BTTS: 8, DC: 12 };

(async () => {
  if (!S.needKey('af/history.js')) return;
  const st = S.loadState();
  const log = { job: 'history' };
  st.markets = MARKETS; st.marketsExtra = {};

  // 1) Bookmaker names (once a week).
  if (!st.metaAt || Date.now() - Date.parse(st.metaAt) > 7 * 86400e3) {
    try {
      for (const b of (await A.get('/odds/bookmakers')).response || []) st.books[b.id] = b.name;
      st.metaAt = new Date(Date.now()).toISOString();
      log.books = Object.keys(st.books).length;
    } catch (e) { log.metaError = e.message; }
  }
  // 2) League types (League / Cup), once a day, one call.
  if (!st.leaguesAt || Date.now() - Date.parse(st.leaguesAt) > 86400e3) {
    try {
      for (const x of (await A.get('/leagues', { current: 'true' })).response || []) {
        const L = st.leagues[x.league.id];
        if (L) { L.type = x.league.type || L.type; L.name = x.league.name || L.name; L.country = (x.country && x.country.name) || L.country; }
      }
      st.leaguesAt = new Date(Date.now()).toISOString();
    } catch (e) { log.leaguesError = e.message; }
  }

  // 3) Seasons to download: leagues with odds, current season first, then earlier ones.
  const withOdds = new Set((st.oddsLeagues || []).map(String));
  for (const [lg, L] of Object.entries(st.leagues)) {
    if (!withOdds.has(lg) || !L.current) continue;
    const year = Number(String(L.current).split('-')[1]);
    for (let k = 1; k <= PAST_SEASONS; k++) {
      const sid = A.sidOf(lg, year - k);
      if (!L.seasons.includes(sid)) L.seasons.push(sid);
      st.seasonLeague[sid] = Number(lg);
    }
    L.seasons.sort((x, y) => Number(y.split('-')[1]) - Number(x.split('-')[1]));
    for (const sid of L.seasons.slice(0, PAST_SEASONS + 1)) st.hist[sid] = st.hist[sid] || { done: false, n: 0 };
  }
  const todo = Object.entries(st.hist).filter(([, h]) => !h.done)
    .sort((a, b) => Number(b[0].split('-')[1]) - Number(a[0].split('-')[1])).map(([sid]) => sid);
  let seasonsDone = 0, matches = 0, used = 0;
  for (const sid of todo) {
    if (used >= MAX_CALLS) { log.stopped = `${MAX_CALLS} calls this run`; break; }
    const [lg, season] = sid.split('-');
    try {
      used++;
      const rows = (await A.get('/fixtures', { league: lg, season })).response || [];
      const fx = rows.map(A.compactFixture);
      matches += S.addResults(fx, st);
      st.hist[sid] = { done: true, n: fx.filter(f => f.hg != null).length, at: new Date(Date.now()).toISOString() };
      seasonsDone++;
    } catch (e) {
      if (e.rateLimited) { log.stopped = e.message; break; }
      const h = st.hist[sid];
      h.error = e.message.slice(0, 160);
      h.done = (h.tries = (h.tries || 0) + 1) >= 3;
    }
    if (seasonsDone % 20 === 0) S.saveState(st);
  }
  Object.assign(log, { seasonsDone, matches, seasonsLeft: Object.values(st.hist).filter(h => !h.done).length, calls: A.callCount(), left: A.remaining() });
  S.saveState(st, log);
  console.log('af/history.js', JSON.stringify(log));
})().catch(e => { console.error('af/history.js failed:', e.message); process.exitCode = 1; });
