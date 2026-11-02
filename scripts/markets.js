// Turns one bookmaker's bets from API-Football into compact keys:
// 1 / X / 2, 1X / X2 / 12, and goal lines O1.5 U1.5 O2.5 U2.5 O3.5 U3.5.
function markets(bm) {
  const m = {};
  for (const b of bm.bets || []) {
    const name = (b.name || '').toLowerCase();
    for (const v of b.values || []) {
      const odd = Number(v.odd);
      if (!(odd > 1)) continue;
      const k = name === 'match winner' ? { Home: '1', Draw: 'X', Away: '2' }[v.value]
        : name === 'double chance' ? { 'Home/Draw': '1X', 'Draw/Away': 'X2', 'Home/Away': '12' }[v.value]
        : name === 'goals over/under' ? (/^(Over|Under) (1\.5|2\.5|3\.5)$/.exec(v.value) || []).slice(1).map((s, i) => i ? s : s[0]).join('') || null
        : null;
      if (k) m[k] = odd;
    }
  }
  return m;
}
module.exports = { markets };
