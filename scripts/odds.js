// Records Bet365 pre-match odds for today's and tomorrow's matches (paper betting).
// The odds endpoint returns 10 matches per page; pages are capped per run so the
// free plan (100 requests/day, 10/minute) is never exceeded. Odds are only stored for
// matches that have not kicked off yet, so results can never leak into the odds.
const path = require('path');
const { ROOT, api, readJSON, writeJSON } = require('./lib');
const { markets } = require('./markets');

const MAX = Number(process.env.ODDS_MAX || 20);
const BOOKMAKER = 8; // Bet365
const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = path.join(ROOT, 'data/odds.json');
const odds = readJSON(file, {});
const now = Date.now() / 1000;
const day = off => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);

(async () => {
  let calls = 0, saved = 0;
  for (const d of [day(0), day(1)]) {
    let page = 1, total = 1;
    while (page <= total && calls < MAX) {
      if (calls) await sleep(6500);
      calls++;
      try {
        const res = await fetch(`https://v3.football.api-sports.io/odds?date=${d}&bookmaker=${BOOKMAKER}&page=${page}`,
          { headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY } }).then(r => r.json());
        const errs = res.errors && Object.values(res.errors);
        if (errs && errs.length) throw new Error(errs.join('; '));
        total = (res.paging && res.paging.total) || 1;
        for (const f of res.response || []) {
          if (!(f.fixture && f.fixture.timestamp > now)) continue; // only before kick-off
          const bm = (f.bookmakers || []).find(b => b.id === BOOKMAKER);
          const m = bm && markets(bm);
          if (m && Object.keys(m).length) {
            // Keep the first price we saw ("open") next to the latest pre-kick-off price,
            // so we can measure whether picks beat the later (closer to closing) price.
            const prev = odds[f.fixture.id];
            const open = prev ? (prev.open || { at: prev.at, m: prev.m }) : { at: Math.floor(now), m };
            odds[f.fixture.id] = { at: Math.floor(now), bm: bm.name, m, open }; saved++;
          }
        }
      } catch (e) { console.error(`odds ${d} p${page}: ${e.message}`); break; }
      page++;
    }
  }
  for (const k in odds) if (now - odds[k].at > 60 * 864e2) delete odds[k];
  writeJSON(file, odds);
  console.log(`odds: ${saved} matches priced with ${calls} requests, ${Object.keys(odds).length} stored`);
})();
