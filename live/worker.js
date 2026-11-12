// Magic Numbers — live pattern logger (Cloudflare Worker, cron every minute).
//
// Watches every live match in the Sportmonks plan (checked 3 times a minute: every ~20 seconds) and
// logs pre-set situations from Marios's
// live-betting experience, with the live price at that moment, then the result. Only the ALERT
// patterns (Marios's rules) go to Telegram; the others are logged quietly so the rules can be
// compared with the situations they leave out. History = StatsBomb minute data, 2,759 matches.
//   P30   ALERT  1st half 28'–34', 2-0/0-2, the two goals 5+ minutes apart   -> goal before HT?
//   P30c  quiet  same, but goals < 5 minutes apart (or minutes unknown)
//               (all 2-0 at 30': 40%; gap <5' 41%, 5–10' 51%, 10'+ 33%)
//   P75   ALERT  2nd half 70'–78', two-goal lead, last two goals 5+ minutes apart -> another goal?
//   P75c  quiet  same, last two goals < 5 minutes apart (or minutes unknown)   (history 49%)
//   PEQ   ALERT  pre-match favourite v outsider; the outsider scores the first goal at 7'–12', the
//                favourite equalises by 30', still 1-1 -> another goal before HT (over 2.5 1st half).
//                History (favourite = better season points, not odds): 10/13 (77%); any 1st-half
//                equaliser 57% (12/21); equaliser after 30' 25% (2/8).
//   PEQL  quiet  same, but the equaliser comes 31'–45'
//   PHT   ALERT  half-time (or 46'–50') at 1-0/0-1; scoring teams (pre-match over 2.5 chance 58%+);
//                1st half 10+ shots or 5+ corners; live over 2.5 at 1.80–2.00 -> over 2.5. The message says
//                whether the favourite or the outsider leads. History (football-data, 8,865 HT 1-0):
//                all 46%, scoring teams 55%, outsider leading 59%, favourite leading 54%.
//   PHTq  quiet  same moment, one of those conditions missing (stats.miss says which)
//   PEQW  quiet  wider: the outsider's first goal is in the first 20' but outside 7'–12', favourite
//                equalises in the 1st half (wider history: 71% by 25', 38% after)
// Favourite = pre-match margin-free win chance at least 20 points above the opponent's (median of
// all bookmakers). Each trigger is stored once (D1 table `triggers`) and graded after the match
// (90-minute score; first-half patterns from the half-time score). Logging only: no bets.
//
// Bindings / secrets (set in the Cloudflare dashboard, never in this file):
//   DB             D1 database
//   SPORTMONKS_KEY Sportmonks API token
//   TG_TOKEN       Telegram bot token (from @BotFather)      — optional; without it nothing is sent
//   TG_CHAT        Telegram chat id to send to              — optional
//   GH_TOKEN       GitHub token (this repo, Actions read/write) — starts the daily slip job on time
// HTTP:  GET /log  -> last 500 triggers as JSON (the GitHub job copies it into the repo daily)
//        GET /test  -> one Telegram test message (at most every 10 minutes)
//        GET /demo  -> three EXAMPLE messages in the real formats (at most every 10 minutes)
//        GET /      -> short status
// Also (every 2 minutes): the line-up check for the daily slip picks, see lineupCheck() below.
// Alerts are held back (logged with sent = -1, no message) after a red card or when the best live
// price is below MIN_PRICE. For every trigger the last-10-minute pressure (corners, shots, dangerous
// attacks per side) is stored, to test later whether pressure improves the late-goal alert.

const BASE = 'https://api.sportmonks.com/v3';
const PATTERNS = {
  P30: { name: '2-0 at 30\', goals 5+ min apart → goal before HT', history: '40% (all 2-0 at 30\')', half: true, alert: true, short: 'goal before half-time' },
  P30c: { name: '2-0 at 30\', goals close together (logged only)', history: '41% (gap < 5\')', half: true, alert: false, short: 'goal before half-time' },
  P75: { name: 'two-goal lead at 70–78\', last goals 5+ min apart → another goal', history: '49% at 75\'', half: false, alert: true, short: 'another goal' },
  P75c: { name: 'two-goal lead at 70–78\', last goals close together (logged only)', history: '47% (gap < 5\')', half: false, alert: false, short: 'another goal' },
  PEQ: { name: 'outsider scores 7–12\', favourite equalises by 30\' → goal before HT', history: '77% (10/13)', half: true, alert: true, short: 'goal before half-time' },
  PEQL: { name: 'outsider scores 7–12\', favourite equalises 31–45\' (logged only)', history: '25% (2/8)', half: true, alert: false, short: 'goal before half-time' },
  PEQW: { name: 'outsider scores in first 20\' (not 7–12\'), favourite equalises in 1st half (logged only)', history: '71% by 25\', 38% after', half: true, alert: false, short: 'goal before half-time' },
  PHT: { name: 'HT 1-0/0-1, scoring teams, 10+ shots or 5+ corners, live over 2.5 at 1.80–2.00 → over 2.5', history: '55% (scoring teams); outsider leading 59%, favourite leading 54%', half: false, alert: true, short: 'over 2.5', line: 2.5 },
  PHTq: { name: 'HT 1-0/0-1, one of the conditions missing (logged only)', history: '46% (all HT 1-0)', half: false, alert: false, short: 'over 2.5', line: 2.5 },
};
const MIN_GAP = 5;            // goals closer together than this (minutes) don't trigger an alert
const FAV_MARGIN = 0.20;      // favourite: pre-match win chance at least this much above the other side's
const HT_MIN_O25 = 0.58, HT_MIN_SHOTS = 10, HT_MIN_CORNERS = 5, HT_PRICE = [1.80, 2.00]; // half-time over 2.5 rule
const MIN_PRICE = 1.80;       // an alert whose best live price is below this is held back (logged, not sent)
const RED_CARDS = [20, 21];   // event types: red card, second yellow
const TREND = { 34: 'corners', 42: 'shots', 86: 'onTarget', 44: 'dangerous', 43: 'attacks' }; // trend type ids
const FINISHED = /^(FT|AET|FT_PEN|AWARDED)$/;
const DEAD = /CANC|POSTP|ABAN|DELETED|SUSP|INTERRUPTED/;

async function sm(env, path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}${path}${q ? '?' + q : ''}`, { headers: { Authorization: env.SPORTMONKS_KEY, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Sportmonks ${r.status} ${path}`);
  return r.json();
}

const side = (f, loc) => (f.participants || []).find(p => p.meta && p.meta.location === loc) || {};
function goals(f, desc) {
  const rows = (f.scores || []).filter(s => s.description === desc && s.score);
  const h = rows.find(s => s.score.participant === 'home'), a = rows.find(s => s.score.participant === 'away');
  return h && a ? [h.score.goals, a.score.goals] : null;
}
function clock(f) {
  const p = f.currentperiod || f.currentPeriod || (f.periods || []).find(x => x.ticking);
  if (!p) return null;
  return { period: p.type_id === 1 ? 1 : p.type_id === 2 ? 2 : 0, minute: p.minutes, added: p.time_added };
}

// Goals in order, from the match events (goal, own goal, penalty; VAR-cancelled ones dropped).
// Who scored is read from the score after each goal ("result"), so own goals are counted right.
// Returns null when the events don't add up to the current score.
function timeline(f, s) {
  const ev = (f.events || []).filter(e => [14, 15, 16].includes(e.type_id) && !e.rescinded)
    .sort((x, y) => (x.minute - y.minute) || ((x.extra_minute || 0) - (y.extra_minute || 0)) || ((x.sort_order || 0) - (y.sort_order || 0)));
  const homeId = side(f, 'home').id;
  let h = 0, a = 0;
  const out = [];
  for (const e of ev) {
    const r = /^(\d+)\s*-\s*(\d+)$/.exec(String(e.result || ''));
    let who;
    if (r) { const nh = +r[1], na = +r[2]; who = nh > h ? 'h' : na > a ? 'a' : null; h = nh; a = na; }
    else { who = (e.participant_id === homeId) !== (e.type_id === 15) ? 'h' : 'a'; who === 'h' ? h++ : a++; }
    if (who) out.push({ min: e.minute + (e.extra_minute ? e.extra_minute / 100 : 0), side: who });
  }
  return s && out.length === s[0] + s[1] && out.filter(g => g.side === 'h').length === s[0] ? out : null;
}

// Half-time break, or the first minutes of the 2nd half (the break itself may come without a clock).
const atHT = f => /^(HT|BREAK|INPLAY_BREAK|HALF_TIME)$/i.test(String((f.state && (f.state.developer_name || f.state.short_name || f.state.state)) || ''));
function htWindow(f, c, s) {
  if (!s || s[0] + s[1] !== 1) return false;
  return atHT(f) || (c && c.period === 2 && c.minute <= 50);
}

// Which pattern (if any) a live fixture is in right now. PEQ/PEQW still need the favourite check;
// PHT needs the pre-match prices, the 1st-half stats and the live price (checked in scan()).
function match(f) {
  const c = clock(f), s = goals(f, 'CURRENT');
  if (htWindow(f, c, s)) return { key: 'PHT', c: c && c.period === 2 ? c : { period: 0, minute: 45, ht: true }, s, info: {}, needHT: true };
  if (!c || !s) return null;
  const [h, a] = s, tot = h + a, lead = Math.abs(h - a);
  const tl = timeline(f, s);
  const gap = () => (tl && tl.length >= 2 ? tl[tl.length - 1].min - tl[tl.length - 2].min : null);
  const info = { goals: tl ? tl.map(g => `${Math.floor(g.min)}'${g.side}`) : null };
  if (c.period === 1 && c.minute >= 28 && c.minute <= 34 && tot === 2 && lead === 2) {
    const g = gap(); return { key: g != null && g >= MIN_GAP ? 'P30' : 'P30c', c, s, info: { ...info, gap: g } };
  }
  if (c.period === 2 && c.minute >= 70 && c.minute <= 78 && lead === 2) {
    const g = gap(); return { key: g != null && g >= MIN_GAP ? 'P75' : 'P75c', c, s, info: { ...info, gap: g } };
  }
  // Favourite equalises after the outsider scored first: picked up within 5 minutes of the equaliser,
  // so the live price is still the one right after it.
  if (c.period === 1 && h === 1 && a === 1 && tl) {
    const [g1, g2] = tl;
    if (g1.side !== g2.side && c.minute >= Math.floor(g2.min) && c.minute - g2.min <= 5) {
      if (g1.min >= 7 && g1.min < 13) return { key: g2.min < 31 ? 'PEQ' : 'PEQL', c, s, info, need: g2.side };
      if (g1.min < 21) return { key: 'PEQW', c, s, info, need: g2.side };
    }
  }
  return null;
}

// Pre-match favourite ('h', 'a' or null) from 1X2 prices, margin removed per bookmaker, median.
async function favourite(env, fid, mk1x2) {
  const j = await sm(env, `/football/odds/pre-match/fixtures/${fid}`, { filters: `markets:${mk1x2}` });
  const per = {};
  for (const o of j.data || []) {
    const L = String(o.label || o.name || '').toLowerCase();
    const k = L === '1' || L === 'home' ? 'h' : L === '2' || L === 'away' ? 'a' : L === 'x' || L === 'draw' ? 'd' : null;
    const p = Number(o.value);
    if (k && p > 1) (per[o.bookmaker_id] = per[o.bookmaker_id] || {})[k] = 1 / p;
  }
  const hs = [], as = [];
  for (const b of Object.values(per)) if (b.h && b.d && b.a) { const t = b.h + b.d + b.a; hs.push(b.h / t); as.push(b.a / t); }
  if (!hs.length) return { fav: null };
  const med = v => { v.sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const ph = med(hs), pa = med(as);
  return { fav: ph - pa >= FAV_MARGIN ? 'h' : pa - ph >= FAV_MARGIN ? 'a' : null, ph: Math.round(ph * 1000) / 1000, pa: Math.round(pa * 1000) / 1000 };
}

// Pre-match view (cached per match): favourite from 1X2 and the over 2.5 chance, margin removed per
// bookmaker (power method for O/U is overkill here: proportional), median over bookmakers.
async function prematch(env, fid) {
  const k = `pm:${fid}`, row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  if (row) return JSON.parse(row.v);
  const j = await sm(env, `/football/odds/pre-match/fixtures/${fid}`, { filters: `markets:${env.MARKET_1X2 || 1},${env.MARKET_OU || 80}` });
  const per = {};
  for (const o of j.data || []) {
    const L = String(o.label || o.name || '').toLowerCase(), p = Number(o.value), b = per[o.bookmaker_id] = per[o.bookmaker_id] || {};
    if (!(p > 1)) continue;
    if (Number(o.market_id) === Number(env.MARKET_OU || 80)) {
      if (Math.abs(Number(o.total) - 2.5) > 1e-9) continue;
      if (L.startsWith('over')) b.o = 1 / p; else if (L.startsWith('under')) b.u = 1 / p;
    } else {
      const kk = L === '1' || L === 'home' ? 'h' : L === '2' || L === 'away' ? 'a' : L === 'x' || L === 'draw' ? 'd' : null;
      if (kk) b[kk] = 1 / p;
    }
  }
  const med = v => { if (!v.length) return null; v.sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const hs = [], as = [], os = [];
  for (const b of Object.values(per)) {
    if (b.h && b.d && b.a) { const t = b.h + b.d + b.a; hs.push(b.h / t); as.push(b.a / t); }
    if (b.o && b.u) os.push(b.o / (b.o + b.u));
  }
  const ph = med(hs), pa = med(as), o25 = med(os), r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
  const out = { fav: ph == null ? null : ph - pa >= FAV_MARGIN ? 'h' : pa - ph >= FAV_MARGIN ? 'a' : null, ph: r3(ph), pa: r3(pa), o25: r3(o25), books: os.length };
  await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, JSON.stringify(out)).run();
  return out;
}

// Live "over" price for (current goals + 0.5): 1st-half market for P30, full match for P75.
function overPrices(odds, line, half, books) {
  const out = [];
  for (const o of odds || []) {
    // Only whole-match / 1st-half TOTAL goals markets. Sportmonks also sends team totals named after the
    // team ("Kawasaki Frontale Goals"), so the names are matched exactly rather than by keyword.
    const md = String(o.market_description || (o.market && o.market.name) || '').trim();
    const isFull = /^(match goals|alternative match goals|goals over\/under|total goals|goal line( \(\d+-\d+\))?)$/i.test(md);
    const isHalf = /^(1st half goals|first half goals|1st half over\/under|1st half goal line( \(\d+-\d+\))?)$/i.test(md);
    if (half ? !isHalf : !isFull) continue;
    const t = Number(String(o.total ?? o.name ?? '').split(',')[0]);
    if (Math.abs(t - line) > 1e-9 || !/^over/i.test(String(o.label || o.name)) || o.stopped || o.suspended) continue;
    const price = Number(o.value || o.dp3);
    if (price > 1) out.push({ book: books[o.bookmaker_id] || (o.bookmaker && o.bookmaker.name) || String(o.bookmaker_id), price });
  }
  out.sort((x, y) => y.price - x.price);
  return out;
}

function statsOf(f) {
  const want = { CORNERS: 'corners', SHOTS_TOTAL: 'shots', SHOTS_ON_TARGET: 'onTarget', DANGEROUS_ATTACKS: 'dangerous', ATTACKS: 'attacks' };
  const out = {};
  for (const s of f.statistics || []) {
    const k = want[s.type && (s.type.developer_name || s.type.code)];
    if (!k) continue;
    const loc = s.location || (s.participant_id === side(f, 'home').id ? 'home' : 'away');
    out[k] = out[k] || { home: 0, away: 0 };
    out[k][loc] = s.data && s.data.value != null ? s.data.value : s.value;
  }
  return out;
}

// Red cards so far ([{ side, min }]), from the match events.
function redCards(f) {
  const homeId = side(f, 'home').id;
  return (f.events || []).filter(e => RED_CARDS.includes(e.type_id) && !e.rescinded)
    .map(e => ({ side: e.participant_id === homeId ? 'h' : 'a', min: e.minute }));
}

// Pressure in the last 10 minutes (corners, shots, dangerous attacks per side), from the per-minute
// "trends" include: value now minus value 10 minutes ago. null when Sportmonks sends no trends.
function pressure(f, minute) {
  const homeId = side(f, 'home').id, by = {};
  for (const t of f.trends || []) {
    const k = TREND[t.type_id], v = Number(t.value ?? t.amount);
    if (!k || !Number.isFinite(v) || t.minute == null) continue;
    (by[k] = by[k] || { home: [], away: [] })[t.participant_id === homeId ? 'home' : 'away'].push([Number(t.minute), v]);
  }
  const out = {};
  for (const [k, sides] of Object.entries(by)) {
    out[k] = {};
    for (const [loc, pts] of Object.entries(sides)) {
      pts.sort((x, y) => x[0] - y[0]);
      const now = pts.length ? pts[pts.length - 1][1] : 0;
      const before = pts.filter(x => x[0] <= minute - 10).pop();
      out[k][loc] = now - (before ? before[1] : 0);
    }
  }
  return Object.keys(out).length ? out : null;
}

async function telegram(env, text, replyTo) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return false;
  const body = { chat_id: env.TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyTo) body.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.ok;
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function setup(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY, fid INTEGER, pattern TEXT, at INTEGER, minute INTEGER, score TEXT, league TEXT,
    home TEXT, away TEXT, line REAL, best REAL, best_book TEXT, prices TEXT, stats TEXT, sent INTEGER,
    result TEXT, hit INTEGER, settled_at INTEGER)`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lineups (
    pid TEXT PRIMARY KEY, fid INTEGER, ts INTEGER, at INTEGER, status TEXT, text TEXT, info TEXT, sent INTEGER)`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS slipres (pid TEXT PRIMARY KEY, fid INTEGER, at INTEGER, hit INTEGER, result TEXT, sent INTEGER)').run();
}

async function bookNames(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'books'").first();
  if (row && Date.now() - JSON.parse(row.v).at < 7 * 86400e3) return JSON.parse(row.v).books;
  const books = {};
  let page = 1;
  for (let i = 0; i < 20; i++) {
    const j = await sm(env, '/odds/bookmakers', { per_page: 50, page });
    for (const b of j.data || []) books[b.id] = b.name;
    if (!j.pagination || !j.pagination.has_more) break;
    page++;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('books', ?)").bind(JSON.stringify({ at: Date.now(), books })).run();
  return books;
}

// Could this live match be in one of the patterns? (score + minute only; cheap)
function maybe(f) {
  const c = clock(f), s = goals(f, 'CURRENT');
  if (htWindow(f, c, s)) return true;
  if (!c || !s) return false;
  const tot = s[0] + s[1], lead = Math.abs(s[0] - s[1]);
  return (c.period === 1 && c.minute >= 28 && c.minute <= 34 && tot === 2 && lead === 2)
    || (c.period === 2 && c.minute >= 70 && c.minute <= 78 && lead === 2)
    || (c.period === 1 && s[0] === 1 && s[1] === 1);
}

// Several D1 lookups in one query: returns a Set of the keys that exist (or a Map key -> value).
async function inTable(env, table, col, keys, withValue) {
  if (!keys.length) return withValue ? new Map() : new Set();
  const rows = (await env.DB.prepare(`SELECT ${col}${withValue ? ', v' : ''} FROM ${table} WHERE ${col} IN (${keys.map(() => '?').join(',')})`).bind(...keys).all()).results || [];
  return withValue ? new Map(rows.map(r => [r[col], r.v])) : new Set(rows.map(r => r[col]));
}

// One check of all live matches. To stay light (it runs 3 times a minute), the live list is fetched
// with scores and clock only; team names, league and goal events are fetched only for matches that
// could be in a pattern, once per score (cached in the meta table as tl:<fixture>:<score>).
async function scan(env) {
  const now = Math.floor(Date.now() / 1000);
  const j = await sm(env, '/football/livescores/inplay', { include: 'scores;currentPeriod;state' });
  let graded = 0;
  try { graded = await liveSettle(env, j.data || []); } catch { /* graded later by settle() */ }
  const pre = (j.data || []).filter(maybe);
  const tkey = f => { const s = goals(f, 'CURRENT'); return `tl:${f.id}:${s[0]}-${s[1]}`; };
  const cache = await inTable(env, 'meta', 'k', pre.map(tkey), true);
  const live = [];
  for (const f of pre) {
    let d = cache.get(tkey(f)) && JSON.parse(cache.get(tkey(f)));
    if (!d) {
      try {
        const x = (await sm(env, `/football/fixtures/${f.id}`, { include: 'participants;events;league' })).data || {};
        d = { at: now, participants: (x.participants || []).map(p => ({ id: p.id, name: p.name, meta: p.meta })),
          events: (x.events || []).filter(e => [14, 15, 16].includes(e.type_id)).map(e => ({ type_id: e.type_id, minute: e.minute, extra_minute: e.extra_minute, result: e.result, participant_id: e.participant_id, rescinded: e.rescinded, sort_order: e.sort_order })),
          league: x.league ? { name: x.league.name } : null };
        await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(tkey(f), JSON.stringify(d)).run();
      } catch { continue; }
    }
    const full = { ...f, participants: d.participants, events: d.events, league: d.league };
    const m = match(full);
    if (m) live.push({ f: full, m });
  }
  const ids = live.map(({ f, m }) => `${f.id}:${m.key}`);
  const done = await inTable(env, 'triggers', 'id', ids);
  const checked = await inTable(env, 'meta', 'k', ids.map(id => `checked:${id}`));
  let books = null, logged = 0, alerts = 0;
  for (const { f, m } of live) {
    const id = `${f.id}:${m.key}`;
    if (done.has(id)) continue;
    if (m.need && checked.has(`checked:${id}`)) continue;
    if (m.need) { // favourite-equalises patterns: the side that equalised must be the pre-match favourite
      let fv = { fav: null };
      try { fv = await favourite(env, f.id, env.MARKET_1X2 || 1); } catch { /* no pre-match odds */ }
      m.info.fav = fv;
      if (fv.fav !== m.need) {
        // remember that this match was checked, so the odds aren't fetched again every minute
        await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind(`checked:${id}`, JSON.stringify(fv)).run();
        continue;
      }
    }
    if (m.needHT) { try { m.info.pm = await prematch(env, f.id); } catch { m.info.pm = null; } }
    books = books || await bookNames(env);
    let d = f;
    try { d = (await sm(env, `/football/fixtures/${f.id}`, { include: 'participants;scores;statistics.type;inplayOdds;events;trends' })).data || f; } catch { /* log without odds */ }
    let P = PATTERNS[m.key];
    const line = P.line || m.s[0] + m.s[1] + 0.5;
    const prices = overPrices(d.inplayodds || d.inplayOdds, line, P.half, books);
    const best = prices[0] || null;
    const pin = prices.find(x => /pinnacle/i.test(x.book)), b365 = prices.find(x => /bet365/i.test(x.book));
    const st = statsOf(d), reds = redCards(d), p10 = pressure(d, m.c.minute);
    if (m.needHT) { // half-time over 2.5: every condition must hold, otherwise it is logged quietly
      const pm = m.info.pm || {}, lead = m.s[0] > m.s[1] ? 'h' : 'a';
      const tot = x => (x ? (Number(x.home) || 0) + (Number(x.away) || 0) : null);
      const sh = tot(st.shots), co = tot(st.corners), miss = [];
      if (!(pm.o25 >= HT_MIN_O25)) miss.push(pm.o25 == null ? 'no pre-match over 2.5 price' : `pre-match over 2.5 only ${Math.round(pm.o25 * 100)}%`);
      if (!((sh != null && sh >= HT_MIN_SHOTS) || (co != null && co >= HT_MIN_CORNERS))) miss.push(`shots ${sh ?? '?'}, corners ${co ?? '?'}`);
      if (!best || best.price < HT_PRICE[0] || best.price > HT_PRICE[1]) miss.push(best ? `price ${best.price.toFixed(2)}` : 'no live price');
      Object.assign(m.info, { leader: pm.fav ? (pm.fav === lead ? 'favourite' : 'outsider') : 'no clear favourite', shots1: sh, corners1: co, miss: miss.length ? miss : undefined });
      if (miss.length) { m.key = 'PHTq'; P = PATTERNS.PHTq; }
    }
    // Alerts are held back (logged quietly) after a red card, or when the live price is too short.
    const held = !P.alert ? null : reds.length ? 'red card' : best && best.price < MIN_PRICE ? `price below ${MIN_PRICE.toFixed(2)}` : null;
    const when = m.c.ht ? 'HT' : `${m.c.minute}'`;
    const H = side(f, 'home').name, A = side(f, 'away').name, lg = f.league ? f.league.name : '';
    const sc = `${m.s[0]}-${m.s[1]}`;
    const be = best ? `break-even ${(100 / best.price).toFixed(0)}%` : 'no live price found';
    // Short message (Marios's choice): match, score, minute, the question and the price. Everything
    // else (bookmakers, history, stats) is still stored in the log and shown on the site.
    const text = [
      `⚽ ${esc(H)} ${sc} ${esc(A)} · ${when}`,
      best ? `Over ${line}${P.half ? ' (1st half)' : ''} @ <b>${best.price.toFixed(2)}</b>` : `Over ${line}${P.half ? ' (1st half)' : ''}`,
      ...(m.needHT && m.info.leader !== 'no clear favourite' ? [`${m.info.leader === 'outsider' ? 'Outsider' : 'Favourite'} leading`] : []),
    ].join('\n');
    const sent = P.alert && !held ? await telegram(env, text).catch(() => false) : false;
    if (P.alert && !held) alerts++;
    await env.DB.prepare(`INSERT OR IGNORE INTO triggers (id, fid, pattern, at, minute, score, league, home, away, line, best, best_book, prices, stats, sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, f.id, m.key, now, m.c.minute, sc, lg, H, A, line, best ? best.price : null, best ? best.book : null,
        JSON.stringify(prices.slice(0, 8)), JSON.stringify({ ...st, ...m.info, reds: reds.length ? reds : undefined, p10: p10 || undefined, held: held || undefined }),
        held ? -1 : sent ? 1 : 0).run();
    logged++;
  }
  return { live: (j.data || []).length, maybe: pre.length, candidates: live.length, logged, alerts, graded };
}

// Store a result and send ✅/❌ for alerts that were sent.
async function grade(env, t, hit, result) {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare('UPDATE triggers SET hit = ?, result = ?, settled_at = ? WHERE id = ? AND hit IS NULL').bind(hit, result, now, t.id).run();
  if (r && r.meta && r.meta.changes === 0) return; // already graded by an overlapping run
  const P = PATTERNS[t.pattern] || {};
  if (hit >= 0 && P.alert && t.sent !== -1) await telegram(env, `${hit ? '✅' : '❌'} ${esc(t.home)} – ${esc(t.away)}: ${esc(P.short)} (${esc(result)})`).catch(() => {});
}

// Grade open triggers straight from the live list (every check, ~20 s): an over bet is won the moment
// the goal goes in, and a 1st-half bet is lost as soon as half-time comes.
async function liveSettle(env, liveList) {
  const open = (await env.DB.prepare('SELECT * FROM triggers WHERE hit IS NULL').all()).results || [];
  if (!open.length) return 0;
  const byId = Object.fromEntries(liveList.map(f => [f.id, f]));
  let n = 0;
  for (const t of open) {
    const f = byId[t.fid];
    if (!f) continue;
    const c = clock(f), cur = goals(f, 'CURRENT'), half = (PATTERNS[t.pattern] || {}).half;
    if (!cur) continue;
    const inFirst = (c && c.period === 1) && !atHT(f);
    if (half) {
      if (inFirst && cur[0] + cur[1] > t.line) { await grade(env, t, 1, `${cur[0]}-${cur[1]} at ${c.minute}'`); n++; continue; }
      const ht = goals(f, '1ST_HALF');
      if (!inFirst && ht && (atHT(f) || (c && c.period === 2))) { await grade(env, t, ht[0] + ht[1] > t.line ? 1 : 0, `HT ${ht[0]}-${ht[1]}`); n++; }
    } else if (cur[0] + cur[1] > t.line) { await grade(env, t, 1, `${cur[0]}-${cur[1]}${c ? ` at ${c.minute}'` : ''}`); n++; }
  }
  return n;
}

// Grade finished triggers (every 2 minutes): losses at full time, and anything the live list missed.
async function settle(env) {
  const now = Math.floor(Date.now() / 1000);
  const open = (await env.DB.prepare('SELECT * FROM triggers WHERE hit IS NULL AND at < ? ORDER BY at LIMIT 40').bind(now - 300).all()).results || [];
  if (!open.length) return 0;
  const ids = [...new Set(open.map(t => t.fid))];
  const j = await sm(env, `/football/fixtures/multi/${ids.join(',')}`, { include: 'scores;state' });
  const byId = Object.fromEntries((j.data || []).map(f => [f.id, f]));
  let n = 0;
  for (const t of open) {
    const f = byId[t.fid];
    if (!f) continue;
    const state = f.state ? (f.state.developer_name || f.state.state) : '';
    let hit = null, result = '';
    if ((PATTERNS[t.pattern] || {}).half) {
      const ht = goals(f, '1ST_HALF');
      if (ht && (FINISHED.test(state) || /HT|2ND|INPLAY_2ND|BREAK/i.test(state))) { hit = ht[0] + ht[1] > t.line ? 1 : 0; result = `HT ${ht[0]}-${ht[1]}`; }
    } else if (FINISHED.test(state)) {
      const ft = goals(f, '2ND_HALF') || goals(f, 'CURRENT');
      if (ft) { hit = ft[0] + ft[1] > t.line ? 1 : 0; result = `FT ${ft[0]}-${ft[1]}`; }
    }
    if (hit == null && (DEAD.test(state) || now - t.at > 4 * 3600)) { hit = -1; result = `void (${state || 'no result'})`; }
    if (hit == null) continue;
    await grade(env, t, hit, result);
    n++;
  }
  return n;
}

// --- Line-up check for the daily slip --------------------------------------------------------------
// About an hour before kick-off the official line-ups come out. For each slip pick the logger then
// checks whether the side(s) that matter start without key players, and replies in Telegram to the
// slip message: ✅ line-ups OK, or ⚠️ with the names. Sides that matter: the backed team for a win
// pick, both teams for goals picks. Key players:
//   scorers  – the team's top 3 league scorers this season with 3+ goals
//   regulars – started at least 4 of the team's last 5 matches (n-1 of n when fewer, at least 3)
// Warning when a key scorer doesn't start, or 3+ regulars don't. Everything is stored (table
// `lineups`) so warned and OK picks can be compared on the results.
const PAGES = 'https://marios9711.github.io/magic-numbers/data/sm';
const LU_TOP = 3, LU_MIN_GOALS = 3, LU_MAX_REG_MISSING = 2, LU_RECENT = 5;
const ymd = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const hhmm = ts => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit' });
const pname = l => l.player_name || (l.player && (l.player.display_name || l.player.common_name || l.player.name)) || `#${l.player_id}`;
const short = n => { const w = String(n).trim().split(/\s+/); return w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : String(n); };

async function pagesJSON(file) {
  try { const r = await fetch(`${PAGES}/${file}?t=${Date.now() >> 16}`); return r.ok ? await r.json() : null; } catch { return null; }
}

// League top scorers of a season (cached 12 hours): [{ pid, tid, goals, name }]
async function seasonScorers(env, sid) {
  const k = `top:${sid}`, row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  if (row) { const c = JSON.parse(row.v); if (Date.now() - c.at < 12 * 3600e3) return c.list; }
  const list = [];
  for (let page = 1; page <= 4; page++) {
    const j = await sm(env, `/football/topscorers/seasons/${sid}`, { include: 'player', filters: 'seasonTopscorerTypes:208', per_page: 50, page });
    for (const t of j.data || []) if (t.type_id == null || t.type_id === 208)
      list.push({ pid: t.player_id, tid: t.participant_id, goals: Number(t.total) || 0, name: t.player ? (t.player.display_name || t.player.common_name || t.player.name) : `#${t.player_id}` });
    if (!j.pagination || !j.pagination.has_more) break;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, JSON.stringify({ at: Date.now(), list })).run();
  return list;
}

// Regular starters from the team's last few matches with line-ups: [{ pid, name, starts, of }]
async function regulars(env, tid, ts) {
  const j = await sm(env, `/football/fixtures/between/${ymd(ts - 45 * 86400)}/${ymd(ts - 3600)}/${tid}`, { include: 'lineups', per_page: 50 });
  const games = (j.data || []).map(f => ({ ts: f.starting_at_timestamp || 0, xi: (f.lineups || []).filter(l => l.type_id === 11 && l.team_id === tid) }))
    .filter(g => g.xi.length >= 11 && g.ts < ts).sort((a, b) => b.ts - a.ts).slice(0, LU_RECENT);
  if (games.length < 3) return [];
  const need = games.length === LU_RECENT ? LU_RECENT - 1 : games.length - 1, cnt = {};
  for (const g of games) for (const l of g.xi) { const c = cnt[l.player_id] = cnt[l.player_id] || { pid: l.player_id, name: pname(l), starts: 0, of: games.length }; c.starts++; }
  return Object.values(cnt).filter(c => c.starts >= need);
}

// Check one team's starting XI against its key players.
async function teamCheck(env, f, team, xi) {
  const started = new Set(xi.filter(l => l.team_id === team.id).map(l => l.player_id));
  let scorers = [], regs = [];
  try { scorers = (await seasonScorers(env, f.season_id)).filter(x => x.tid === team.id && x.goals >= LU_MIN_GOALS).sort((a, b) => b.goals - a.goals).slice(0, LU_TOP); } catch { /* no scorer data */ }
  try { regs = await regulars(env, team.id, f.starting_at_timestamp); } catch { /* no recent line-ups */ }
  const missTop = scorers.map((x, i) => ({ ...x, rank: i + 1 })).filter(x => !started.has(x.pid));
  const missReg = regs.filter(x => !started.has(x.pid) && !missTop.some(y => y.pid === x.pid));
  const warn = missTop.length > 0 || missReg.length > LU_MAX_REG_MISSING;
  const bits = missTop.map(x => `${short(x.name)} (${x.rank === 1 ? 'top scorer, ' : ''}${x.goals} goals)`);
  if (missReg.length) bits.push(`${missReg.length} regular starter${missReg.length > 1 ? 's' : ''} (${missReg.slice(0, 3).map(x => short(x.name)).join(', ')}${missReg.length > 3 ? '…' : ''})`);
  return { team: team.name, warn, text: bits.filter(Boolean).join(', '), scorers: scorers.length, regulars: regs.length,
    missTop: missTop.map(x => ({ name: x.name, goals: x.goals, rank: x.rank })), missReg: missReg.map(x => x.name) };
}

// --- Results for the daily slip -------------------------------------------------------------------
// The GitHub job only runs a few times a day (and GitHub often starts it hours late), so the logger
// grades slip picks itself every 2 minutes and replies to the slip message with ✅/❌:
//   wins on goals are sent the moment the line is passed; everything else at half-time (1st-half
//   picks) or full time. Stored in D1 table `slipres`; the GitHub job skips the ones sent here.
function slipOutcome(key, f) {
  const state = f.state ? (f.state.developer_name || f.state.state || '') : '';
  const done = FINISHED.test(state), ft = goals(f, '2ND_HALF') || goals(f, 'CURRENT'), cur = goals(f, 'CURRENT'), ht = goals(f, '1ST_HALF');
  const c = clock(f), inFirst = c && c.period === 1 && !atHT(f);
  if (DEAD.test(state)) return { hit: -1, result: `void (${state})` };
  if (key === 'HO1.5') {
    if (inFirst && cur && cur[0] + cur[1] > 1.5) return { hit: 1, result: `${cur[0]}-${cur[1]} at ${c.minute}'` };
    if (!inFirst && ht && (done || atHT(f) || (c && c.period === 2))) return { hit: ht[0] + ht[1] > 1.5 ? 1 : 0, result: `HT ${ht[0]}-${ht[1]}` };
    return null;
  }
  if (key === 'O2.5' && !done && cur && cur[0] + cur[1] > 2.5) return { hit: 1, result: `${cur[0]}-${cur[1]}${c ? ` at ${c.minute}'` : ''}` };
  if (!done || !ft) return null;
  const [h, a] = ft;
  const hit = key === '1' ? (h > a ? 1 : 0) : key === '2' ? (a > h ? 1 : 0) : key === 'O2.5' ? (h + a > 2.5 ? 1 : 0) : null;
  return hit == null ? null : { hit, result: `FT ${h}-${a}` };
}

async function slipResults(env) {
  const now = Math.floor(Date.now() / 1000);
  const slip = await pagesJSON('slip.json');
  if (!slip) return { picks: 0 };
  const picks = [...(slip.slip || []), ...(slip.history || [])].filter(p => p.ts < now && p.ts > now - 2 * 86400 && p.r == null);
  if (!picks.length) return { picks: 0 };
  const done = await inTable(env, 'slipres', 'pid', picks.map(p => p.id));
  const todo = picks.filter(p => !done.has(p.id)).slice(0, 40);
  if (!todo.length) return { picks: picks.length, graded: 0 };
  const j = await sm(env, `/football/fixtures/multi/${[...new Set(todo.map(p => p.fid))].join(',')}`, { include: 'scores;state;currentPeriod' });
  const byId = Object.fromEntries((j.data || []).map(f => [f.id, f]));
  let msgs = null, graded = 0;
  for (const p of todo) {
    const f = byId[p.fid];
    let o = f ? slipOutcome(p.key, f) : null;
    if (!o && now - p.ts > 6 * 3600) o = { hit: -1, result: 'void (no result)' };
    if (!o) continue;
    msgs = msgs || await pagesJSON('tgmsg.json') || {};
    const text = o.hit < 0 ? `➖ ${esc(p.hn)} – ${esc(p.an)}: ${esc(p.pick)} (${esc(o.result)})` : `${o.hit ? '✅' : '❌'} ${esc(p.hn)} – ${esc(p.an)}: ${esc(p.pick)} (${esc(o.result)})`;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO slipres (pid, fid, at, hit, result, sent) VALUES (?, ?, ?, ?, ?, 0)').bind(p.id, p.fid, now, o.hit, o.result).run();
    if (r && r.meta && r.meta.changes === 0) continue;
    const sent = await telegram(env, text, msgs[p.id]).catch(() => false);
    await env.DB.prepare('UPDATE slipres SET sent = ? WHERE pid = ?').bind(sent ? 1 : 0, p.id).run();
    graded++;
  }
  return { picks: picks.length, graded };
}

// Runs every 2 minutes; does the full check for at most one pick per run (subrequest limits).
async function lineupCheck(env) {
  const now = Math.floor(Date.now() / 1000);
  const slip = await pagesJSON('slip.json');
  if (!slip) return { picks: 0 };
  const picks = [...(slip.slip || []), ...(slip.history || [])].filter(p => p.ts > now - 15 * 60 && p.ts < now + 90 * 60);
  if (!picks.length) return { picks: 0 };
  const done = await inTable(env, 'lineups', 'pid', picks.map(p => p.id));
  const todo = picks.filter(p => !done.has(p.id)).sort((a, b) => a.ts - b.ts);
  let msgs = null, checked = 0, waiting = 0;
  for (const p of todo) {
    if (checked) break;
    let f;
    try { f = (await sm(env, `/football/fixtures/${p.fid}`, { include: 'participants;lineups' })).data; } catch { continue; }
    if (!f) continue;
    const xi = (f.lineups || []).filter(l => l.type_id === 11), H = side(f, 'home'), A = side(f, 'away');
    const full = t => xi.filter(l => l.team_id === t.id).length >= 11;
    if (!full(H) || !full(A)) {
      if (now > p.ts + 10 * 60) await env.DB.prepare('INSERT OR IGNORE INTO lineups (pid, fid, ts, at, status, sent) VALUES (?, ?, ?, ?, ?, 0)').bind(p.id, p.fid, p.ts, now, 'none').run();
      else waiting++;
      continue;
    }
    checked++;
    const sides = p.key === '1' ? [H] : p.key === '2' ? [A] : [H, A];
    const res = [];
    for (const t of sides) res.push(await teamCheck(env, f, t, xi));
    const warn = res.some(r => r.warn);
    const head = `${esc(p.hn)} – ${esc(p.an)} · ${hhmm(p.ts)}`, pk = `${esc(p.pick)} @ <b>${Number(p.odds).toFixed(2)}</b>`;
    const lines = warn
      ? [`⚠️ ${head}`, pk, ...res.filter(r => r.warn).map(r => `${esc(r.team)} without ${esc(r.text)}`)]
      : [`✅ ${head}`, `${pk} — line-ups OK`];
    msgs = msgs || await pagesJSON('tgmsg.json') || {};
    const sent = await telegram(env, lines.join('\n'), msgs[p.id]).catch(() => false);
    await env.DB.prepare('INSERT OR REPLACE INTO lineups (pid, fid, ts, at, status, text, info, sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(p.id, p.fid, p.ts, now, warn ? 'warn' : 'ok', lines.slice(2).join(' · '), JSON.stringify(res), sent ? 1 : 0).run();
  }
  return { picks: picks.length, checked, waiting };
}

// --- /probe: shows the shape of the data the logger relies on (live match + an upcoming pick) ----------
async function probe(env, fidParam) {
  const out = {};
  const keys = o => (o && typeof o === 'object' ? Object.keys(o).slice(0, 25) : o);
  const count = (arr, f) => (arr || []).reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  // 1) a live match
  try {
    const j = await sm(env, '/football/livescores/inplay', { include: 'scores;currentPeriod' });
    const live = j.data || [];
    out.liveCount = live.length;
    const f0 = live.find(f => clock(f)) || live[0];
    if (f0) {
      out.liveClock = clock(f0); out.liveScore = goals(f0, 'CURRENT');
      const d = (await sm(env, `/football/fixtures/${f0.id}`, { include: 'participants;scores;statistics.type;inplayOdds;events;trends;league' })).data || {};
      const s = goals(d, 'CURRENT');
      out.live = {
        id: d.id, league: d.league && d.league.name, teams: (d.participants || []).map(p => `${p.name} (${p.meta && p.meta.location})`),
        scores: (d.scores || []).map(x => `${x.description}:${x.score && x.score.participant}=${x.score && x.score.goals}`),
        eventTypes: count(d.events, e => e.type_id), eventSample: (d.events || []).slice(0, 3).map(e => ({ type_id: e.type_id, minute: e.minute, extra: e.extra_minute, result: e.result, participant_id: e.participant_id, rescinded: e.rescinded })),
        timeline: timeline(d, s), reds: redCards(d),
        trendTypes: count(d.trends, t => t.type_id), trendSample: (d.trends || []).slice(-3).map(t => ({ ...t })), trendKeys: keys((d.trends || [])[0]),
        pressure: pressure(d, (clock(d) || {}).minute || 0),
        statsTypes: (d.statistics || []).slice(0, 40).map(x => x.type && (x.type.developer_name || x.type.code)).filter(Boolean),
        stats: statsOf(d),
        inplayOddsN: (d.inplayodds || d.inplayOdds || []).length, inplayKeys: keys((d.inplayodds || d.inplayOdds || [])[0]),
        inplayMarkets: count(d.inplayodds || d.inplayOdds, o => o.market_description || (o.market && o.market.name) || o.market_id),
        inplaySample: (d.inplayodds || d.inplayOdds || []).filter(o => /goal/i.test(String(o.market_description || ''))).slice(0, 6)
          .map(o => ({ market: o.market_description, label: o.label, name: o.name, total: o.total, value: o.value, book: o.bookmaker_id, stopped: o.stopped, suspended: o.suspended })),
      };
      if (s) {
        const books = await bookNames(env);
        out.live.overFull = overPrices(d.inplayodds || d.inplayOdds, s[0] + s[1] + 0.5, false, books).slice(0, 4);
        out.live.overHalf = overPrices(d.inplayodds || d.inplayOdds, s[0] + s[1] + 0.5, true, books).slice(0, 4);
      }
    }
  } catch (e) { out.liveError = e.message; }
  // 2) an upcoming match (from the slip page's value board unless ?fid= is given): injuries, scorers, recent line-ups
  try {
    let fid = fidParam ? Number(fidParam) : null;
    if (!fid) { const sl = await pagesJSON('slip.json'); const v = sl && (sl.slip[0] || sl.value[0]); fid = v && v.fid; }
    if (fid) {
      const f = (await sm(env, `/football/fixtures/${fid}`, { include: 'participants;lineups;sidelined.sideline;league' })).data || {};
      const H = side(f, 'home');
      out.upcoming = {
        id: f.id, league: f.league && f.league.name, season: f.season_id, start: f.starting_at_timestamp,
        teams: (f.participants || []).map(p => `${p.id} ${p.name} (${p.meta && p.meta.location})`),
        lineupsN: (f.lineups || []).length, sidelinedN: (f.sidelined || []).length,
        sidelinedSample: (f.sidelined || []).slice(0, 3).map(x => ({ keys: keys(x), sideline: x.sideline && { player_id: x.sideline.player_id, category: x.sideline.category, completed: x.sideline.completed, team_id: x.sideline.team_id } })),
      };
      const top = await seasonScorers(env, f.season_id);
      out.upcoming.scorersN = top.length;
      out.upcoming.scorersHome = top.filter(x => x.tid === H.id).sort((a, b) => b.goals - a.goals).slice(0, 3);
      const regs = await regulars(env, H.id, f.starting_at_timestamp || Math.floor(Date.now() / 1000));
      out.upcoming.regularsHome = regs.map(r => `${r.name} ${r.starts}/${r.of}`);
      const j = await sm(env, `/football/fixtures/between/${ymd(Math.floor(Date.now() / 1000) - 30 * 86400)}/${ymd(Math.floor(Date.now() / 1000))}/${H.id}`, { include: 'lineups', per_page: 50 });
      const g = (j.data || []).find(x => (x.lineups || []).length);
      out.upcoming.recentLineupTypes = g ? count(g.lineups, l => l.type_id) : null;
      out.upcoming.recentLineupSample = g ? g.lineups.slice(0, 2).map(l => ({ player_id: l.player_id, team_id: l.team_id, type_id: l.type_id, player_name: l.player_name, position_id: l.position_id })) : null;
      if ((f.lineups || []).filter(l => l.type_id === 11).length >= 22) out.upcoming.check = await teamCheck(env, f, H, f.lineups.filter(l => l.type_id === 11));
    }
  } catch (e) { out.upcomingError = e.message; }
  return out;
}

// --- Starting the daily slip job on time ---------------------------------------------------------------
// GitHub's own schedule often starts hours late, so the logger starts the "Daily slip (Sportmonks)"
// workflow itself at 07:07, 13:07, 18:07 and 23:07 Bucharest time. Needs the secret GH_TOKEN: a
// fine-grained GitHub token for this repository only, with "Actions: read and write".
const SLIP_TIMES = ['07:07', '13:07', '18:07', '23:07'];
async function startSlipJob(env) {
  const r = await fetch('https://api.github.com/repos/marios9711/magic-numbers/actions/workflows/sportmonks.yml/dispatches', {
    method: 'POST', body: JSON.stringify({ ref: 'main' }),
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'magic-numbers-live' },
  });
  const res = { at: new Date().toISOString(), status: r.status, ok: r.status === 204 };
  if (!res.ok) res.error = (await r.text().catch(() => '')).slice(0, 200);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('dispatch', ?)").bind(JSON.stringify(res)).run();
  return res;
}
async function dispatchSlip(env) {
  if (!env.GH_TOKEN) return null;
  const now = new Date();
  const hm = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit' });
  if (!SLIP_TIMES.includes(hm)) return null;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind(`dispatch:${now.toISOString().slice(0, 10)} ${hm}`, '1').run();
  if (r && r.meta && r.meta.changes === 0) return null; // already started this slot
  return startSlipJob(env);
}

// Each cron run (once a minute) checks 3 times: at 0, 20 and 40 seconds.
const CHECKS_PER_RUN = 3, CHECK_EVERY_MS = 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(env, checks = CHECKS_PER_RUN, every = CHECK_EVERY_MS) {
  if (!env.SPORTMONKS_KEY) return { skipped: 'no SPORTMONKS_KEY' };
  await setup(env);
  const t0 = Date.now(), out = { checks: 0, live: 0, maybe: 0, candidates: 0, logged: 0, alerts: 0, errors: 0 };
  try { const d = await dispatchSlip(env); if (d) out.dispatch = d; } catch (e) { out.dispatch = { error: e.message }; }
  for (let i = 0; i < checks; i++) {
    if (i) { const wait = t0 + i * every - Date.now(); if (wait > 0) await sleep(wait); }
    try {
      const r = await scan(env);
      out.checks++; out.live = r.live; out.maybe = Math.max(out.maybe, r.maybe);
      out.candidates += r.candidates; out.logged += r.logged; out.alerts += r.alerts; out.graded = (out.graded || 0) + (r.graded || 0);
    } catch (e) { out.errors++; out.error = e.message; }
  }
  if (new Date(t0).getUTCMinutes() % 2 === 0) {
    try { out.lineups = await lineupCheck(env); } catch (e) { out.lineups = { error: e.message }; }
  }
  if (new Date(t0).getUTCMinutes() % 2 === 1) {
    try { out.settled = await settle(env); } catch (e) { out.settleError = e.message; }
    try { out.slip = await slipResults(env); } catch (e) { out.slip = { error: e.message }; }
  }
  if (new Date(t0).getUTCMinutes() % 10 === 0) {
    // forget cached goal timelines older than 6 hours
    await env.DB.prepare("DELETE FROM meta WHERE k LIKE 'tl:%' AND json_extract(v, '$.at') < ?").bind(Math.floor(t0 / 1000) - 6 * 3600).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last', ?)").bind(JSON.stringify({ at: new Date().toISOString(), ...out })).run();
  return out;
}

async function summary(env) {
  const rows = (await env.DB.prepare('SELECT * FROM triggers ORDER BY at DESC LIMIT 500').all()).results || [];
  const by = {};
  // alerts held back (red card, short price) are counted on their own line
  const pats = { ...PATTERNS };
  for (const [k, P] of Object.entries(PATTERNS)) if (P.alert) pats[`${k}:held`] = { ...P, alert: false, name: `${P.name} — held back (red card or price below ${MIN_PRICE.toFixed(2)})` };
  for (const r of rows) {
    r.key = r.sent === -1 ? `${r.pattern}:held` : r.pattern;
    const b = by[r.key] = by[r.key] || { n: 0, settled: 0, hit: 0, withPrice: 0, profit: 0 };
    b.n++;
    if (r.hit === 0 || r.hit === 1) {
      b.settled++; b.hit += r.hit;
      if (r.best) { b.withPrice++; b.profit += r.hit ? 10 * (r.best - 1) : -10; }
    }
  }
  const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last'").first();
  const lineups = (await env.DB.prepare('SELECT * FROM lineups ORDER BY ts DESC LIMIT 400').all()).results || [];
  const slipres = (await env.DB.prepare('SELECT * FROM slipres ORDER BY at DESC LIMIT 400').all()).results || [];
  return { at: new Date().toISOString(), lineups, slipres, last: last ? JSON.parse(last.v) : null, patterns: pats, summary: by, rows };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env).catch(e => console.log('run failed', e.message))); },
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    try {
      await setup(env);
      if (url.pathname === '/log') return new Response(JSON.stringify(await summary(env)), { headers });
      if (url.pathname === '/demo') { // three EXAMPLE messages in the real formats (at most every 10 minutes)
        const t = await env.DB.prepare("SELECT v FROM meta WHERE k = 'demo'").first();
        if (t && Date.now() - Number(t.v) < 600e3) return new Response(JSON.stringify({ ok: false, error: 'demo already sent in the last 10 minutes' }), { headers });
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('demo', ?)").bind(String(Date.now())).run();
        const msgs = [
          ['🧪 <b>EXAMPLE — not a real pick</b>', '',
            '🧾 <b>Daily slip 21 Nov</b>', '',
            '<b>Win</b>',
            '• Sat 15:00 Example Town – Sample City',
            '   Sample City to win @ <b>2.45</b>', '',
            '<b>Over 2.5</b>',
            '• Sat 17:30 Demo United – Test Rovers',
            '   Over 2.5 goals @ <b>2.10</b>', '',
            '<b>1st-half over 1.5</b>',
            '• Sun 13:00 Model Athletic – Placeholder FC',
            '   Over 1.5 goals, 1st half @ <b>3.20</b>'].join('\n'),
          ['🧪 <b>EXAMPLE — not a real alert</b>', '',
            "⚽ Demo United 2-0 Test Rovers · 31'",
            'Over 2.5 (1st half) @ <b>2.30</b>'].join('\n'),
          ['🧪 <b>EXAMPLE</b>', '', '✅ Demo United – Test Rovers: goal before half-time (HT 3-0)', '',
            '📊 <b>Results</b>',
            '✅ Example Town – Sample City: Sample City to win (0-1)',
            '✅ Demo United – Test Rovers: Over 2.5 goals (3-1)',
            '❌ Model Athletic – Placeholder FC: Over 1.5 goals, 1st half (HT 0-1)'].join('\n'),
        ];
        const sent = [];
        for (const m of msgs) sent.push(await telegram(env, m).catch(() => false));
        return new Response(JSON.stringify({ ok: true, sent }), { headers });
      }
      if (url.pathname === '/dispatch') { // starts the daily slip job now, to test GH_TOKEN (at most every 10 minutes)
        if (!env.GH_TOKEN) return new Response(JSON.stringify({ ok: false, error: 'GH_TOKEN secret is not set' }), { headers });
        const t = await env.DB.prepare("SELECT v FROM meta WHERE k = 'dispatchTest'").first();
        if (t && Date.now() - Number(t.v) < 600e3) return new Response(JSON.stringify({ ok: false, error: 'already started in the last 10 minutes' }), { headers });
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('dispatchTest', ?)").bind(String(Date.now())).run();
        return new Response(JSON.stringify(await startSlipJob(env)), { headers });
      }
      if (url.pathname === '/probe') { // one-off data check: what Sportmonks sends back (at most every 5 minutes)
        const t = await env.DB.prepare("SELECT v FROM meta WHERE k = 'probe'").first();
        if (t && Date.now() - Number(t.v) < 300e3) return new Response(JSON.stringify({ ok: false, error: 'probe already run in the last 5 minutes' }), { headers });
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('probe', ?)").bind(String(Date.now())).run();
        return new Response(JSON.stringify(await probe(env, url.searchParams.get('fid')), null, 1), { headers });
      }
      if (url.pathname === '/test') { // sends one Telegram test message (at most every 10 minutes)
        const t = await env.DB.prepare("SELECT v FROM meta WHERE k = 'test'").first();
        if (t && Date.now() - Number(t.v) < 600e3) return new Response(JSON.stringify({ ok: false, error: 'test already sent in the last 10 minutes' }), { headers });
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('test', ?)").bind(String(Date.now())).run();
        const sent = await telegram(env, '✅ <b>Magic Numbers</b> live logger is connected. Live alerts and the daily slip will arrive here.').catch(() => false);
        return new Response(JSON.stringify({ ok: true, sent, sportmonksKey: !!env.SPORTMONKS_KEY, telegram: !!(env.TG_TOKEN && env.TG_CHAT) }), { headers });
      }
      const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last'").first();
      const disp = await env.DB.prepare("SELECT v FROM meta WHERE k = 'dispatch'").first();
      return new Response(JSON.stringify({ ok: true, last: last ? JSON.parse(last.v) : null, slipJob: env.GH_TOKEN ? (disp ? JSON.parse(disp.v) : 'token set, not used yet') : 'no GH_TOKEN' }), { headers });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers }); }
  },
};

export { match, timeline, overPrices, statsOf, run, summary, lineupCheck, pressure, redCards, probe, slipResults };
