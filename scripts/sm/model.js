// A plain goals model, used only as a second opinion next to the market's chances.
// Per league: each team gets an attack and a defence strength from the last 2 years of league
// results (recent games count more: half weight after 180 days), plus home and away scoring
// averages. Expected goals: home = homeAvg x attack(home) x defence(away), and the same for away.
// Scores follow a Poisson distribution with a small Dixon–Coles correction for 0-0/1-0/0-1/1-1.
// It is NOT used to choose picks until it proves itself (see the model check on the slip page).
const { settle } = require('./smlib');

const HALF_LIFE_D = 180, WINDOW_D = 730, PRIOR = 2, MIN_GAMES = 6, RHO = -0.08, MAXG = 10;

function fit(rows, asOf) {
  const use = rows.filter(r => r[1] < asOf && r[1] > asOf - WINDOW_D * 86400 && r[4] != null);
  if (use.length < 60) return null;
  const w = use.map(r => 0.5 ** ((asOf - r[1]) / 86400 / HALF_LIFE_D));
  const W = w.reduce((a, b) => a + b, 0);
  const baseH = use.reduce((s, r, i) => s + w[i] * r[4], 0) / W;
  const baseA = use.reduce((s, r, i) => s + w[i] * r[5], 0) / W;
  const teams = new Set(); const games = {};
  for (const r of use) { teams.add(r[2]); teams.add(r[3]); games[r[2]] = (games[r[2]] || 0) + 1; games[r[3]] = (games[r[3]] || 0) + 1; }
  const att = {}, def = {};
  for (const t of teams) { att[t] = 1; def[t] = 1; }
  for (let it = 0; it < 30; it++) {
    const aN = {}, aD = {}, dN = {}, dD = {};
    for (const t of teams) { aN[t] = PRIOR; aD[t] = PRIOR; dN[t] = PRIOR; dD[t] = PRIOR; }
    use.forEach((r, i) => {
      const [, , h, a, hg, ag] = r, wi = w[i];
      aN[h] += wi * hg; aD[h] += wi * baseH * def[a];
      aN[a] += wi * ag; aD[a] += wi * baseA * def[h];
      dN[h] += wi * ag; dD[h] += wi * baseA * att[a];
      dN[a] += wi * hg; dD[a] += wi * baseH * att[h];
    });
    let ma = 0, md = 0;
    for (const t of teams) { att[t] = aN[t] / aD[t]; def[t] = dN[t] / dD[t]; ma += att[t]; md += def[t]; }
    ma /= teams.size; md /= teams.size;
    for (const t of teams) { att[t] /= ma; def[t] /= md; }
  }
  return { baseH, baseA, att, def, games };
}

function matrix(m, h, a) {
  if (!m || (m.games[h] || 0) < MIN_GAMES || (m.games[a] || 0) < MIN_GAMES) return null;
  const lh = m.baseH * m.att[h] * m.def[a], la = m.baseA * m.att[a] * m.def[h];
  const pois = l => { const p = [Math.exp(-l)]; for (let k = 1; k <= MAXG; k++) p[k] = p[k - 1] * l / k; return p; };
  const ph = pois(lh), pa = pois(la);
  const M = [];
  let s = 0;
  for (let i = 0; i <= MAXG; i++) {
    M[i] = [];
    for (let j = 0; j <= MAXG; j++) {
      let tau = 1;
      if (i === 0 && j === 0) tau = 1 - lh * la * RHO;
      else if (i === 0 && j === 1) tau = 1 + lh * RHO;
      else if (i === 1 && j === 0) tau = 1 + la * RHO;
      else if (i === 1 && j === 1) tau = 1 - RHO;
      M[i][j] = ph[i] * pa[j] * tau; s += M[i][j];
    }
  }
  for (const row of M) for (let j = 0; j <= MAXG; j++) row[j] /= s;
  return { M, xg: [lh, la] };
}

// Chance for any selection key, made comparable with a market's margin-free chance:
// on lines with pushes/half results it is the break-even chance A / (A + B).
function prob(mx, key) {
  if (!mx) return null;
  let A = 0, B = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const r = settle(key, i, j);
    if (r == null) return null;
    if (r > 0) A += mx.M[i][j] * r; else if (r < 0) B += mx.M[i][j] * -r;
  }
  return A + B > 0 ? A / (A + B) : null;
}

module.exports = { fit, matrix, prob };
