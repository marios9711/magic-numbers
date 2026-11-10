// Sportmonks: league list, bookmaker/market names, and past seasons' results.
// Per league: the current season + up to 3 earlier ones (what the Pro plan includes).
// Each season is downloaded once (finished seasons are then marked done); the current season is
// kept up to date by results.js. Stops early when the hourly Fixture allowance runs low and
// carries on at the next run, so the first full download takes a few runs on day 1.
const S = require('./smlib');

const PAST_SEASONS = 3;
const KEEP_SPARE = 250;           // leave this many Fixture calls for results.js and odds.js this hour

(async () => {
  if (!S.needKey('history.js')) return;
  const st = S.loadState();
  const log = { job: 'history' };

  // 1) Leagues in the plan, with their seasons (refreshed once a day).
  if (!st.leaguesAt || Date.now() - Date.parse(st.leaguesAt) > 20 * 3600e3) {
    const leagues = await S.all('/football/leagues', { include: 'seasons;country' });
    for (const L of leagues) {
      const seasons = (L.seasons || []).filter(s => s.starting_at)
        .sort((a, b) => b.starting_at.localeCompare(a.starting_at));
      const cur = seasons.find(s => s.is_current) || seasons[0];
      if (!cur) continue;
      const pick = [cur, ...seasons.filter(s => s.id !== cur.id && s.starting_at < cur.starting_at).slice(0, PAST_SEASONS)];
      st.leagues[L.id] = {
        name: L.name, country: L.country ? L.country.name : '', type: L.type || L.sub_type || '',
        seasons: pick.map(s => s.id), current: cur.id,
      };
      for (const s of pick) { st.seasonLeague[s.id] = L.id; st.hist[s.id] = st.hist[s.id] || { done: false, n: 0, name: s.name, finished: !!s.finished }; }
    }
    st.leaguesAt = new Date(Date.now()).toISOString();
    log.leagues = Object.keys(st.leagues).length;
  }

  // 2) Bookmaker and market names (once a week).
  if (!st.metaAt || Date.now() - Date.parse(st.metaAt) > 7 * 86400e3) {
    try {
      for (const b of await S.all('/odds/bookmakers')) st.books[b.id] = b.name;
      const mk = await S.all('/odds/markets');
      const find = (re, dflt) => (mk.find(m => re.test(m.name || m.developer_name || '')) || { id: dflt }).id;
      st.markets = {
        '1X2': find(/^(fulltime result|full ?time result|match winner|3way result)$/i, 1),
        DC: find(/^double chance$/i, 2),
        BTTS: find(/^both teams to score$/i, 14),
        OU: find(/^goals over\/under$/i, 80),
        AH: find(/^asian handicap$/i, null),
      };
      st.metaAt = new Date(Date.now()).toISOString();
      log.books = Object.keys(st.books).length; log.markets = st.markets;
    } catch (e) { log.metaError = e.message; }
  }
  S.saveState(st);

  // 3) Seasons not downloaded yet (newest first, so the current seasons are ready first).
  const todo = Object.entries(st.hist).filter(([, h]) => !h.done)
    .sort((a, b) => Number(b[0]) - Number(a[0])).map(([sid]) => sid);
  let seasonsDone = 0, matches = 0;
  for (const sid of todo) {
    const left = S.limits.Fixture;
    if (left != null && left < KEEP_SPARE + 20) { log.stopped = `Fixture calls left ${left}`; break; }
    try {
      const rows = await S.all('/football/fixtures', { filters: `fixtureSeasons:${sid}`, include: 'participants;scores;state' });
      const fx = rows.map(S.compactFixture);
      matches += S.addResults(fx, st);
      const h = st.hist[sid];
      h.n = fx.filter(f => f.hg != null).length;
      // A finished season is complete; the current one is marked done too (results.js adds new games).
      h.done = true; h.at = new Date(Date.now()).toISOString();
      seasonsDone++;
      S.saveState(st);
    } catch (e) {
      if (e.rateLimited) { log.stopped = 'rate limit'; break; }
      st.hist[sid].error = e.message.slice(0, 160);
      st.hist[sid].done = (st.hist[sid].tries = (st.hist[sid].tries || 0) + 1) >= 3;
    }
  }
  log.seasonsDone = seasonsDone; log.matches = matches;
  log.seasonsLeft = Object.values(st.hist).filter(h => !h.done).length;
  S.saveState(st, log);
  console.log('history.js', JSON.stringify(log));
})().catch(e => { console.error('history.js failed:', e.message); process.exitCode = 1; });
