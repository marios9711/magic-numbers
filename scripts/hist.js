// One-off: downloads historical results and bookmaker odds from football-data.co.uk for the
// backtest leagues (2022–25 seasons) and saves trimmed copies in data/hist/. No API-Football
// requests are used. Run manually from the Actions tab ("History odds").
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib');

const MAIN = { 39: 'E0', 40: 'E1', 41: 'E2', 140: 'SP1', 141: 'SP2', 135: 'I1', 136: 'I2', 78: 'D1', 79: 'D2', 61: 'F1', 62: 'F2', 88: 'N1', 94: 'P1', 197: 'G1', 203: 'T1', 144: 'B1', 179: 'SC0' };
const EXTRA = { 218: 'AUT', 207: 'SWZ', 119: 'DNK', 113: 'SWE', 103: 'NOR', 106: 'POL', 283: 'ROU', 235: 'RUS', 71: 'BRA', 128: 'ARG', 253: 'USA', 262: 'MEX', 98: 'JPN' };
const KEEP = ['Season', 'Date', 'Time', 'HomeTeam', 'AwayTeam', 'Home', 'Away', 'FTHG', 'FTAG', 'HG', 'AG',
  'B365H', 'B365D', 'B365A', 'B365>2.5', 'B365<2.5', 'B365CH', 'B365CD', 'B365CA', 'B365C>2.5', 'B365C<2.5',
  'PSH', 'PSD', 'PSA', 'PSCH', 'PSCD', 'PSCA', 'P>2.5', 'P<2.5', 'PC>2.5', 'PC<2.5',
  'MaxH', 'MaxD', 'MaxA', 'Max>2.5', 'Max<2.5', 'MaxCH', 'MaxCD', 'MaxCA', 'MaxC>2.5', 'MaxC<2.5',
  'AvgH', 'AvgD', 'AvgA', 'Avg>2.5', 'Avg<2.5', 'AvgCH', 'AvgCD', 'AvgCA', 'AvgC>2.5', 'AvgC<2.5',
  // match statistics (main leagues): half-time goals, shots, shots on target, corners, fouls, cards, referee
  'HTHG', 'HTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'HF', 'AF', 'HY', 'AY', 'HR', 'AR', 'Referee'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = path.join(ROOT, 'data/hist');
fs.mkdirSync(out, { recursive: true });

function trim(text, keepRow = () => true) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(s => s.trim());
  const idx = KEEP.map(k => head.indexOf(k)).filter(i => i >= 0);
  const rows = lines.slice(1).map(l => l.split(',')).filter(c => keepRow(c, head));
  return [idx.map(i => head[i]).join(','), ...rows.map(c => idx.map(i => (c[i] || '').trim()).join(','))].join('\n') + '\n';
}

(async () => {
  let ok = 0, bad = 0;
  for (const [lg, code] of Object.entries(MAIN)) for (const [s, tag] of [[2022, '2223'], [2023, '2324'], [2024, '2425'], [2025, '2526']]) {
    try {
      const r = await fetch(`https://www.football-data.co.uk/mmz4281/${tag}/${code}.csv`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(path.join(out, `${lg}-${s}.csv`), trim(await r.text())); ok++;
    } catch (e) { bad++; console.error(`${code} ${tag}: ${e.message}`); }
    await sleep(1500);
  }
  for (const [lg, code] of Object.entries(EXTRA)) {
    try {
      const r = await fetch(`https://www.football-data.co.uk/new/${code}.csv`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      for (const s of [2022, 2023, 2024, 2025]) {
        const t = trim(text, (c, head) => String(c[head.indexOf('Season')] || '').trim().startsWith(String(s)));
        if (t.split('\n').length > 2) { fs.writeFileSync(path.join(out, `${lg}-${s}.csv`), t); ok++; }
      }
    } catch (e) { bad++; console.error(`${code}: ${e.message}`); }
    await sleep(1500);
  }
  console.log(`history: ${ok} league-season files saved, ${bad} failed`);
})();
