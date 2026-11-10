// Motivation from the league table (late season only), built from our own results.
// Same definitions as the test on football-data.co.uk history (30 leagues, 2022–25, Pinnacle closing):
//   early   – less than a quarter of the season played, or more than 10 games left (no tag)
//   top     – within 3 points of the title/promotion places (top 10% of the table) and still able to reach them
//   bottom  – within 3 points of the drop zone (bottom 15%) or in it, and still able to escape
//   nothing – cannot reach the top places and cannot be caught by the drop zone any more
//   mid     – everything else
// The table is approximate: split seasons, play-offs and point deductions are not modelled.
// Season length comes from the previous season of the same league (else a double round robin).

const T_SHARE = 0.10, R_SHARE = 0.15, MAX_LEFT = 10, MIN_PLAYED = 0.25;

function table(rows, asOf) {
  const tb = {};
  for (const r of rows) {
    if (r[1] >= asOf || r[4] == null) continue;
    for (const t of [r[2], r[3]]) tb[t] = tb[t] || { pts: 0, pl: 0 };
    const [h, a] = r[4] > r[5] ? [3, 0] : r[4] === r[5] ? [1, 1] : [0, 3];
    tb[r[2]].pts += h; tb[r[3]].pts += a; tb[r[2]].pl++; tb[r[3]].pl++;
  }
  return tb;
}

function seasonLength(prevRows, nTeams) {
  if (prevRows && prevRows.length) {
    const g = {};
    for (const r of prevRows) { g[r[2]] = (g[r[2]] || 0) + 1; g[r[3]] = (g[r[3]] || 0) + 1; }
    const max = Math.max(...Object.values(g));
    if (max >= 10) return max;
  }
  return 2 * (nTeams - 1);
}

// -> { stateOf(teamId) } for a league's current season as of time asOf (seconds)
function standings(curRows, prevRows, asOf) {
  const tb = table(curRows, asOf);
  const teams = Object.keys(tb), N = teams.length;
  if (N < 6) return { stateOf: () => 'early', N };
  const G = seasonLength(prevRows, N);
  const R = Math.max(1, Math.round(N * R_SHARE)), T = Math.max(1, Math.round(N * T_SHARE));
  const order = teams.map(t => tb[t].pts).sort((a, b) => b - a);
  const Ptop = order[T - 1], Psafe = order[N - R - 1], Prel = order[N - R];
  const stateOf = id => {
    const me = tb[id];
    if (!me) return 'early';
    const L = Math.max(0, G - me.pl);
    if (me.pl < G * MIN_PLAYED || L > MAX_LEFT || L === 0) return 'early';
    if (me.pts >= Ptop - 3 && me.pts + 3 * L >= Ptop) return 'top';
    if (me.pts <= Psafe + 3 && me.pts + 3 * L >= Psafe) return 'bottom';
    if (me.pts + 3 * L < Ptop && me.pts > Prel + 3 * L) return 'nothing';
    return 'mid';
  };
  return { stateOf, N, G };
}

const motivated = s => s === 'top' || s === 'bottom';

// Rules fixed from the history test (kept small on purpose; judged again on live picks):
//  boost: added to the market's chance before the edge is worked out (about 60% of the historical gap)
//  block: never pick this selection in this situation
const RULES = [
  { id: 'awayMotivated', key: '2', boost: 0.03, when: (h, a) => motivated(a) && h === 'nothing',
    text: 'Away side still playing for something, home side has nothing left (history: away won 38.1% vs 33.1% priced, 572 games)' },
  { id: 'bothNothing', key: 'O2.5', boost: 0.02, when: (h, a) => h === 'nothing' && a === 'nothing',
    text: 'Neither side has anything left to play for (history: over 2.5 hit 61.5% vs 57.1% priced, 522 games)' },
  { id: 'homeNothingVsMotivated', key: '1', block: true, when: (h, a) => h === 'nothing' && motivated(a),
    text: 'Home side has nothing left, away side does (history: home won 38.6% vs 42.6% priced)' },
  { id: 'bothMotivated', key: 'O2.5', block: true, when: (h, a) => motivated(h) && motivated(a),
    text: 'Both sides under pressure: tighter games (history: over 2.5 hit 49.6% vs 51.9% priced)' },
];

function rulesFor(h, a, key) { return RULES.filter(r => r.key === key && r.when(h, a)); }

const words = { top: 'in the title/promotion race', bottom: 'fighting relegation', nothing: 'nothing to play for', mid: 'mid-table', early: '' };

module.exports = { standings, rulesFor, RULES, words, motivated };
