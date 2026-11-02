// Backup data source: football-data.co.uk (free CSV files, no API key, no request quota).
// Downloads this season's results and the upcoming-fixtures files (with Bet365, Pinnacle,
// best and average odds) for about 38 leagues into data/fdco/. Used by `SOURCE=fd node scripts/build.js`.
const fs = require('fs');
const path = require('path');
const { ROOT, writeJSON } = require('./lib');

const MAIN = ['E0', 'E1', 'E2', 'E3', 'EC', 'SC0', 'SC1', 'SC2', 'SC3', 'D1', 'D2', 'I1', 'I2', 'SP1', 'SP2', 'F1', 'F2', 'N1', 'B1', 'P1', 'T1', 'G1'];
const EXTRA = ['ARG', 'AUT', 'BRA', 'CHN', 'DNK', 'FIN', 'IRL', 'JPN', 'MEX', 'NOR', 'POL', 'ROU', 'RUS', 'SWE', 'SWZ', 'USA'];
const KEEP = ['Div', 'Country', 'League', 'Season', 'Date', 'Time', 'HomeTeam', 'AwayTeam', 'Home', 'Away', 'FTHG', 'FTAG', 'HG', 'AG',
  'B365H', 'B365D', 'B365A', 'B365>2.5', 'B365<2.5', 'B365CH', 'B365CD', 'B365CA', 'B365C>2.5', 'B365C<2.5',
  'PSH', 'PSD', 'PSA', 'P>2.5', 'P<2.5', 'PSCH', 'PSCD', 'PSCA', 'PC>2.5', 'PC<2.5',
  'MaxH', 'MaxD', 'MaxA', 'Max>2.5', 'Max<2.5', 'MaxCH', 'MaxCD', 'MaxCA', 'MaxC>2.5', 'MaxC<2.5',
  'AvgH', 'AvgD', 'AvgA', 'Avg>2.5', 'Avg<2.5', 'AvgCH', 'AvgCD', 'AvgCA', 'AvgC>2.5', 'AvgC<2.5',
  // match statistics (main leagues): half-time goals, shots, shots on target, corners, fouls, cards, referee
  'HTHG', 'HTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'HF', 'AF', 'HY', 'AY', 'HR', 'AR', 'Referee'];
const BASE = 'https://www.football-data.co.uk';
const out = path.join(ROOT, 'data/fdco');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Season code for the main leagues: Aug–Jun seasons, e.g. 2026/27 -> "2627".
const now = new Date(), y = now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
const SEASON = String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');

function parse(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(l => { const c = l.split(','); const o = {}; head.forEach((h, i) => { if (KEEP.includes(h) && c[i] != null && c[i].trim() !== '') o[h] = c[i].trim(); }); return o; });
}
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const status = { at: new Date().toISOString(), season: SEASON, results: {}, errors: [] };
  for (const code of MAIN) {
    try { const rows = parse(await get(`${BASE}/mmz4281/${SEASON}/${code}.csv`)); writeJSON(path.join(out, `res-${code}.json`), rows); status.results[code] = rows.length; }
    catch (e) { status.errors.push(`${code}: ${e.message}`); }
    await sleep(1200);
  }
  for (const code of EXTRA) {
    try {
      const all = parse(await get(`${BASE}/new/${code}.csv`));
      // Keep the latest season present in the file (calendar-year or split season).
      const last = all.reduce((m, r) => (r.Season && r.Season > m ? r.Season : m), '');
      const rows = all.filter(r => r.Season === last);
      writeJSON(path.join(out, `res-${code}.json`), rows); status.results[code] = `${rows.length} (${last})`;
    } catch (e) { status.errors.push(`${code}: ${e.message}`); }
    await sleep(1200);
  }
  for (const [name, file] of [['fixtures', 'fixtures.csv'], ['fixtures-extra', 'new_league_fixtures.csv']]) {
    try { const rows = parse(await get(`${BASE}/${file}`)); writeJSON(path.join(out, `${name}.json`), rows); status[name] = rows.length; }
    catch (e) { status.errors.push(`${file}: ${e.message}`); }
    await sleep(1200);
  }
  writeJSON(path.join(out, 'status.json'), status);
  console.log(JSON.stringify(status));
})();
