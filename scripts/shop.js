// Line shopping: for the day's shortlisted selections (written by build.js to data/shop.json),
// fetch every bookmaker's prices and keep the best one for each bet. One request per match,
// at most SHOP_MAX per run (default 10), so the daily total stays well under the free plan's 100.
const path = require('path');
const { ROOT, readJSON, writeJSON } = require('./lib');
const { markets } = require('./markets');

const MAX = Number(process.env.SHOP_MAX || 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = path.join(ROOT, 'data/best.json');
const best = readJSON(file, {});
const now = Date.now() / 1000;
const list = readJSON(path.join(ROOT, 'data/shop.json'), { ids: [] }).ids.slice(0, MAX);

(async () => {
  let calls = 0, saved = 0;
  for (const id of list) {
    await sleep(6500); // also spaces us from the odds step's last request (10 a minute max)
    calls++;
    try {
      const res = await fetch(`https://v3.football.api-sports.io/odds?fixture=${id}`,
        { headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY } }).then(r => r.json());
      const errs = res.errors && Object.values(res.errors);
      if (errs && errs.length) throw new Error(errs.join('; '));
      const f = (res.response || [])[0];
      if (!f || !(f.fixture && f.fixture.timestamp > now)) continue; // only before kick-off
      const b = {};
      for (const bm of f.bookmakers || []) for (const [k, o] of Object.entries(markets(bm))) if (!b[k] || o > b[k][0]) b[k] = [o, bm.name];
      if (Object.keys(b).length) { best[id] = { at: Math.floor(now), n: (f.bookmakers || []).length, b }; saved++; }
    } catch (e) { console.error(`shop ${id}: ${e.message}`); }
  }
  for (const k in best) if (now - best[k].at > 60 * 864e2) delete best[k];
  writeJSON(file, best);
  console.log(`shop: ${saved}/${list.length} shortlisted matches priced across bookmakers with ${calls} requests`);
})();
