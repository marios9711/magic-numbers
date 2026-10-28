// Backtest on past seasons (free plan allows 2022-2024).
// Downloads one league-season per request (cached in data/seasons), at most MAX_CALLS per run,
// so repeated runs fill in the list within the 100 requests/day limit.
// Note: form here is league matches only (cup games are not included).
const fs = require('fs');
const path = require('path');
const { ROOT, api, compact, readJSON, writeJSON, evaluate, stats } = require('./lib');

const MAX_CALLS = Number(process.env.MAX_CALLS || 80);
const cfg = readJSON(path.join(ROOT, 'config.json'), {});
const leagues = cfg.backtestLeagues || [];
const seasons = cfg.backtestSeasons || [2022, 2023, 2024];

(async () => {
  let calls = 0;
  for (const L of leagues) for (const y of seasons) {
    const p = path.join(ROOT, 'data/seasons', `${L.id}-${y}.json`);
    if (fs.existsSync(p) || calls >= MAX_CALLS) continue;
    try {
      calls++;
      const rows = (await api(`/fixtures?league=${L.id}&season=${y}`)).map(compact);
      writeJSON(p, { league: L.id, season: y, rows });
      console.log(`${L.name} ${y}: ${rows.length} fixtures`);
    } catch (e) { console.error(`${L.name} ${y}: ${e.message}`); }
  }

  const dir = path.join(ROOT, 'data/seasons');
  const all = [], perLeague = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const d = readJSON(path.join(dir, f), null);
    if (!d || !d.rows.length) continue;
    const { results } = evaluate(d.rows); // each league-season evaluated on its own history
    all.push(...results);
  }
  const S = stats(all);
  S.meta = {
    updated: new Date().toISOString(),
    leagueSeasons: fs.existsSync(dir) ? fs.readdirSync(dir).length : 0,
    planned: leagues.length * seasons.length,
    note: 'League matches only; form builds up from each season start, so the first ~7 rounds are not predicted.',
  };
  writeJSON(path.join(ROOT, 'docs/data/backtest.json'), S);
  console.log(`backtest: ${S.graded} graded predictions from ${S.meta.leagueSeasons}/${S.meta.planned} league-seasons (${calls} API calls this run)`);
})();
