// Injuries and suspensions for new slip picks (checked once, when a pick is logged).
// Key players = the team's top 3 league scorers this season with 3+ goals. If one of them is listed
// as injured or suspended for the match, the pick gets a warning (shown in Telegram and on the site).
// The pick itself is kept: whether warned picks really do worse is judged on the results.
// Sides that matter: the backed team for a win pick, both teams for goals picks.
const S = require('./smlib');

const TOP = 3, MIN_GOALS = 3;
const cache = {};
const short = n => { const w = String(n).trim().split(/\s+/); return w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : String(n); };

async function scorers(sid) {
  if (cache[sid]) return cache[sid];
  const rows = await S.all(`/football/topscorers/seasons/${sid}`, { include: 'player', filters: 'seasonTopscorerTypes:208' }, { maxPages: 4 });
  cache[sid] = rows.filter(t => t.type_id == null || t.type_id === 208).map(t => ({
    pid: t.player_id, tid: t.participant_id, goals: Number(t.total) || 0,
    name: t.player ? (t.player.display_name || t.player.common_name || t.player.name) : `#${t.player_id}`,
  }));
  return cache[sid];
}

// -> { out: [{ team, name, goals, rank, why }], warn: 'text' | null }
async function check(pick) {
  const j = await S.get(`/football/fixtures/${pick.fid}`, { include: 'participants;sidelined.sideline' });
  const f = j && j.data;
  if (!f) return null;
  const parts = f.participants || [];
  const team = loc => parts.find(p => p.meta && p.meta.location === loc);
  const sides = (pick.key === '1' ? [team('home')] : pick.key === '2' ? [team('away')] : [team('home'), team('away')]).filter(Boolean);
  const list = await scorers(f.season_id);
  const outIds = new Map();
  for (const s of f.sidelined || []) {
    const sl = s.sideline || {};
    if (sl.completed === true) continue;
    const pid = sl.player_id || s.player_id;
    if (pid) outIds.set(pid, String(sl.category || '').toLowerCase() || 'out');
  }
  const out = [];
  for (const t of sides) {
    const top = list.filter(x => x.tid === t.id && x.goals >= MIN_GOALS).sort((a, b) => b.goals - a.goals).slice(0, TOP);
    top.forEach((x, i) => { if (outIds.has(x.pid)) out.push({ team: t.name, name: x.name, goals: x.goals, rank: i + 1, why: outIds.get(x.pid) }); });
  }
  const warn = out.length ? out.map(x => `${x.team} without ${short(x.name)} (${x.rank === 1 ? 'top scorer, ' : ''}${x.goals} goals${x.why && x.why !== 'out' ? `, ${x.why}` : ''})`).join('; ') : null;
  return { out, warn };
}

module.exports = { check };
