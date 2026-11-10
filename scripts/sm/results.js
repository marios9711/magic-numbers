// Sportmonks: fixtures from 3 days ago to 7 days ahead in every league of the plan.
//  - finished ones go into the season files (results for the model and for grading picks)
//  - upcoming ones go to data/sm/upcoming.json (the list odds.js snapshots)
const S = require('./smlib');

const BACK_DAYS = 3, AHEAD_DAYS = 7;

(async () => {
  if (!S.needKey('results.js')) return;
  const st = S.loadState();
  const d = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const rows = await S.all(`/football/fixtures/between/${d(-BACK_DAYS)}/${d(AHEAD_DAYS)}`, { include: 'participants;scores;state' });
  const fx = rows.map(S.compactFixture).filter(f => f.h && f.a);
  const added = S.addResults(fx, st);
  const t = S.now();
  const upcoming = fx.filter(f => f.ts > t - 3 * 3600 && f.hg == null && !/CANC|POSTP|ABAN|DELETED|AWARD|WO/i.test(f.st))
    .map(({ id, lg, sid, ts, st: state, h, a, hn, an, odds }) => ({ id, lg, sid, ts, st: state, h, a, hn, an, odds }))
    .sort((x, y) => x.ts - y.ts);
  // Kick-off times that changed are kept with the newest value (moved matches).
  S.writeJSON(S.p('upcoming.json'), { at: new Date(Date.now()).toISOString(), fixtures: upcoming });
  const log = { job: 'results', fixtures: fx.length, newResults: added, upcoming: upcoming.length, withOdds: upcoming.filter(f => f.odds).length };
  S.saveState(st, log);
  console.log('results.js', JSON.stringify(log));
})().catch(e => { console.error('results.js failed:', e.message); process.exitCode = 1; });
