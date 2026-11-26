// Injuries and suspensions for new slip picks, API-Football version of scripts/sm/squad.js
// (same output). Key players = the team's top 3 league scorers this season with 3+ goals
// (/players/topscorers: the league's top 20). Out = listed by /injuries for this fixture as
// "Missing Fixture" (injured or suspended; "Questionable" ones are not counted).
const A = require('./aflib');

const TOP = 3, MIN_GOALS = 3;
const cache = {};
const short = n => { const w = String(n).trim().split(/\s+/); return w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : String(n); };

async function scorers(lg, season) {
  const k = `${lg}-${season}`;
  if (cache[k]) return cache[k];
  const rows = (await A.get('/players/topscorers', { league: lg, season })).response || [];
  cache[k] = rows.map(r => {
    const s = (r.statistics || [])[0] || {};
    return { pid: r.player.id, tid: s.team && s.team.id, goals: Number(s.goals && s.goals.total) || 0, name: r.player.name };
  });
  return cache[k];
}

// -> { out: [{ team, name, goals, rank, why }], warn: 'text' | null }
async function check(pick) {
  const f = ((await A.get('/fixtures', { id: pick.fid })).response || [])[0];
  if (!f) return null;
  const H = f.teams.home, Aw = f.teams.away;
  const sides = pick.key === '1' ? [H] : pick.key === '2' ? [Aw] : [H, Aw];
  const list = await scorers(f.league.id, f.league.season);
  const inj = (await A.get('/injuries', { fixture: pick.fid })).response || [];
  const outIds = new Map();
  for (const x of inj) {
    if (!/missing/i.test(String(x.player && x.player.type))) continue;
    outIds.set(x.player.id, String(x.player.reason || 'out').toLowerCase());
  }
  const out = [];
  for (const t of sides) {
    const top = list.filter(x => x.tid === t.id && x.goals >= MIN_GOALS).sort((a, b) => b.goals - a.goals).slice(0, TOP);
    top.forEach((x, i) => { if (outIds.has(x.pid)) out.push({ team: t.name, name: x.name, goals: x.goals, rank: i + 1, why: outIds.get(x.pid) }); });
  }
  const warn = out.length ? out.map(x => `${x.team} without ${short(x.name)} (${x.rank === 1 ? 'top scorer, ' : ''}${x.goals} goals${x.why && x.why !== 'out' ? `, ${x.why}` : ''})`).join('; ') : null;
  return { out, warn };
}

module.exports = { check, scorers };
