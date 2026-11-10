// Magic Numbers — live pattern logger (Cloudflare Worker, cron every minute).
//
// Watches every live match in the Sportmonks plan and logs pre-set situations from Marios's
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
// HTTP:  GET /log  -> last 500 triggers as JSON (the GitHub job copies it into the repo daily)
//        GET /test  -> one Telegram test message (at most every 10 minutes)
//        GET /demo  -> three EXAMPLE messages in the real formats (at most every 10 minutes)
//        GET /      -> short status

const BASE = 'https://api.sportmonks.com/v3';
const PATTERNS = {
  P30: { name: '2-0 at 30\', goals 5+ min apart → goal before HT', history: '40% (all 2-0 at 30\')', half: true, alert: true, short: 'goal before half-time' },
  P30c: { name: '2-0 at 30\', goals close together (logged only)', history: '41% (gap < 5\')', half: true, alert: false, short: 'goal before half-time' },
  P75: { name: 'two-goal lead at 70–78\', last goals 5+ min apart → another goal', history: '49% at 75\'', half: false, alert: true, short: 'another goal' },
  P75c: { name: 'two-goal lead at 70–78\', last goals close together (logged only)', history: '47% (gap < 5\')', half: false, alert: false, short: 'another goal' },
  PEQ: { name: 'outsider scores 7–12\', favourite equalises by 30\' → goal before HT', history: '77% (10/13)', half: true, alert: true, short: 'goal before half-time' },
  PEQL: { name: 'outsider scores 7–12\', favourite equalises 31–45\' (logged only)', history: '25% (2/8)', half: true, alert: false, short: 'goal before half-time' },
  PEQW: { name: 'outsider scores in first 20\' (not 7–12\'), favourite equalises in 1st half (logged only)', history: '71% by 25\', 38% after', half: true, alert: false, short: 'goal before half-time' },
};
const MIN_GAP = 5;            // goals closer together than this (minutes) don't trigger an alert
const FAV_MARGIN = 0.20;      // favourite: pre-match win chance at least this much above the other side's
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

// Which pattern (if any) a live fixture is in right now. PEQ/PEQW still need the favourite check.
function match(f) {
  const c = clock(f), s = goals(f, 'CURRENT');
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

// Live "over" price for (current goals + 0.5): 1st-half market for P30, full match for P75.
function overPrices(odds, line, half, books) {
  const out = [];
  for (const o of odds || []) {
    const md = String(o.market_description || (o.market && o.market.name) || '');
    if (!/over\/under|goals/i.test(md) || /team|asian|corner|card|exact|odd|even|both|range|handicap|minute|home|away/i.test(md)) continue;
    const isHalf = /1st half|first half/i.test(md);
    if (isHalf !== half || /2nd half|second half/i.test(md)) continue;
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

async function telegram(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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

async function scan(env) {
  const now = Math.floor(Date.now() / 1000);
  const j = await sm(env, '/football/livescores/inplay', { include: 'participants;scores;currentPeriod;league;events' });
  const live = (j.data || []).map(f => ({ f, m: match(f) })).filter(x => x.m);
  let books = null, logged = 0, alerts = 0;
  for (const { f, m } of live) {
    const id = `${f.id}:${m.key}`;
    if (await env.DB.prepare('SELECT 1 FROM triggers WHERE id = ?').bind(id).first()) continue;
    if (m.need && await env.DB.prepare('SELECT 1 FROM meta WHERE k = ?').bind(`checked:${id}`).first()) continue;
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
    books = books || await bookNames(env);
    let d = f;
    try { d = (await sm(env, `/football/fixtures/${f.id}`, { include: 'participants;scores;statistics.type;inplayOdds' })).data || f; } catch { /* log without odds */ }
    const P = PATTERNS[m.key], line = m.s[0] + m.s[1] + 0.5;
    const prices = overPrices(d.inplayodds || d.inplayOdds, line, P.half, books);
    const best = prices[0] || null;
    const pin = prices.find(x => /pinnacle/i.test(x.book)), b365 = prices.find(x => /bet365/i.test(x.book));
    const st = statsOf(d);
    const H = side(f, 'home').name, A = side(f, 'away').name, lg = f.league ? f.league.name : '';
    const sc = `${m.s[0]}-${m.s[1]}`;
    const be = best ? `break-even ${(100 / best.price).toFixed(0)}%` : 'no live price found';
    // Short message (Marios's choice): match, score, minute, the question and the price. Everything
    // else (bookmakers, history, stats) is still stored in the log and shown on the site.
    const text = [
      `⚽ ${esc(H)} ${sc} ${esc(A)} · ${m.c.minute}'`,
      best ? `Over ${line}${P.half ? ' (1st half)' : ''} @ <b>${best.price.toFixed(2)}</b>` : `Over ${line}${P.half ? ' (1st half)' : ''}`,
    ].join('\n');
    const sent = P.alert ? await telegram(env, text).catch(() => false) : false;
    if (P.alert) alerts++;
    await env.DB.prepare(`INSERT OR IGNORE INTO triggers (id, fid, pattern, at, minute, score, league, home, away, line, best, best_book, prices, stats, sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, f.id, m.key, now, m.c.minute, sc, lg, H, A, line, best ? best.price : null, best ? best.book : null,
        JSON.stringify(prices.slice(0, 8)), JSON.stringify({ ...st, ...m.info }), sent ? 1 : 0).run();
    logged++;
  }
  return { live: (j.data || []).length, candidates: live.length, logged, alerts };
}

// Grade finished triggers (checked every 10 minutes).
async function settle(env) {
  const now = Math.floor(Date.now() / 1000);
  const open = (await env.DB.prepare('SELECT * FROM triggers WHERE hit IS NULL AND at < ? ORDER BY at LIMIT 40').bind(now - 1800).all()).results || [];
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
    await env.DB.prepare('UPDATE triggers SET hit = ?, result = ?, settled_at = ? WHERE id = ?').bind(hit, result, now, t.id).run();
    const P = PATTERNS[t.pattern] || {};
    if (hit >= 0 && P.alert) await telegram(env, `${hit ? '✅' : '❌'} ${esc(t.home)} – ${esc(t.away)}: ${esc(P.short)} (${esc(result)})`).catch(() => {});
    n++;
  }
  return n;
}

async function run(env) {
  if (!env.SPORTMONKS_KEY) return { skipped: 'no SPORTMONKS_KEY' };
  await setup(env);
  const out = await scan(env);
  if (new Date().getUTCMinutes() % 10 === 0) out.settled = await settle(env);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last', ?)").bind(JSON.stringify({ at: new Date().toISOString(), ...out })).run();
  return out;
}

async function summary(env) {
  const rows = (await env.DB.prepare('SELECT * FROM triggers ORDER BY at DESC LIMIT 500').all()).results || [];
  const by = {};
  for (const r of rows) {
    const b = by[r.pattern] = by[r.pattern] || { n: 0, settled: 0, hit: 0, withPrice: 0, profit: 0 };
    b.n++;
    if (r.hit === 0 || r.hit === 1) {
      b.settled++; b.hit += r.hit;
      if (r.best) { b.withPrice++; b.profit += r.hit ? 10 * (r.best - 1) : -10; }
    }
  }
  const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last'").first();
  return { at: new Date().toISOString(), last: last ? JSON.parse(last.v) : null, patterns: PATTERNS, summary: by, rows };
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
      if (url.pathname === '/test') { // sends one Telegram test message (at most every 10 minutes)
        const t = await env.DB.prepare("SELECT v FROM meta WHERE k = 'test'").first();
        if (t && Date.now() - Number(t.v) < 600e3) return new Response(JSON.stringify({ ok: false, error: 'test already sent in the last 10 minutes' }), { headers });
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('test', ?)").bind(String(Date.now())).run();
        const sent = await telegram(env, '✅ <b>Magic Numbers</b> live logger is connected. Live alerts and the daily slip will arrive here.').catch(() => false);
        return new Response(JSON.stringify({ ok: true, sent, sportmonksKey: !!env.SPORTMONKS_KEY, telegram: !!(env.TG_TOKEN && env.TG_CHAT) }), { headers });
      }
      const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last'").first();
      return new Response(JSON.stringify({ ok: true, last: last ? JSON.parse(last.v) : null }), { headers });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers }); }
  },
};

export { match, timeline, overPrices, statsOf, run, summary };
