// Magic Numbers — live pattern logger (Cloudflare Worker, cron every minute).
//
// Watches every live match in the Sportmonks plan and logs two pre-set situations from Marios's
// live-betting experience, with the live price at that moment, then the result:
//   P30  first half, 28'–34', score 2-0 or 0-2  -> another goal before half-time?
//        (StatsBomb history, 2,759 matches: 40% (96/238))
//   P75  second half, 70'–78', a two-goal lead   -> another goal before full time?
//        (history: 49% at 75', 56% at 70', 40% at 80')
// Each trigger is stored once (D1 table `triggers`), sent to Telegram, and graded after the
// match (90-minute score; P30 from the half-time score). Logging only: no bets are placed.
//
// Bindings / secrets (set in the Cloudflare dashboard, never in this file):
//   DB             D1 database
//   SPORTMONKS_KEY Sportmonks API token
//   TG_TOKEN       Telegram bot token (from @BotFather)      — optional; without it nothing is sent
//   TG_CHAT        Telegram chat id to send to              — optional
// HTTP:  GET /log  -> last 500 triggers as JSON (the GitHub job copies it into the repo daily)
//        GET /test  -> one Telegram test message (at most every 10 minutes)
//        GET /      -> short status

const BASE = 'https://api.sportmonks.com/v3';
const PATTERNS = {
  P30: { name: '2-0 at 30\' → goal before HT', history: '40% of 238 matches', half: true },
  P75: { name: 'two-goal lead at 70–78\' → another goal', history: '49% at 75\', 56% at 70\'', half: false },
};
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

// Which pattern (if any) a live fixture is in right now.
function match(f) {
  const c = clock(f), s = goals(f, 'CURRENT');
  if (!c || !s) return null;
  const [h, a] = s, tot = h + a, lead = Math.abs(h - a);
  if (c.period === 1 && c.minute >= 28 && c.minute <= 34 && tot === 2 && lead === 2) return { key: 'P30', c, s };
  if (c.period === 2 && c.minute >= 70 && c.minute <= 78 && lead === 2) return { key: 'P75', c, s };
  return null;
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
  const j = await sm(env, '/football/livescores/inplay', { include: 'participants;scores;currentPeriod;league' });
  const live = (j.data || []).map(f => ({ f, m: match(f) })).filter(x => x.m);
  let books = null, logged = 0;
  for (const { f, m } of live) {
    const id = `${f.id}:${m.key}`;
    if (await env.DB.prepare('SELECT 1 FROM triggers WHERE id = ?').bind(id).first()) continue;
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
    const text = [
      `⚽ <b>${esc(lg)}</b> · ${esc(H)} ${sc} ${esc(A)} · ${m.c.minute}'`,
      `Pattern: ${esc(P.name)}`,
      best ? `Over ${line}${P.half ? ' (1st half)' : ''} @ <b>${best.price.toFixed(2)}</b> ${esc(best.book)}${pin ? ` · Pinnacle ${pin.price.toFixed(2)}` : ''}${b365 ? ` · bet365 ${b365.price.toFixed(2)}` : ''}` : 'Live price: not available',
      `History: ${esc(P.history)} · ${be}`,
      st.corners || st.shots ? `Corners ${st.corners ? `${st.corners.home}-${st.corners.away}` : '–'} · shots ${st.shots ? `${st.shots.home}-${st.shots.away}` : '–'}${st.dangerous ? ` · dangerous attacks ${st.dangerous.home}-${st.dangerous.away}` : ''}` : '',
      '<i>Logged for the test — paper only.</i>',
    ].filter(Boolean).join('\n');
    const sent = await telegram(env, text).catch(() => false);
    await env.DB.prepare(`INSERT OR IGNORE INTO triggers (id, fid, pattern, at, minute, score, league, home, away, line, best, best_book, prices, stats, sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, f.id, m.key, now, m.c.minute, sc, lg, H, A, line, best ? best.price : null, best ? best.book : null,
        JSON.stringify(prices.slice(0, 8)), JSON.stringify(st), sent ? 1 : 0).run();
    logged++;
  }
  return { live: (j.data || []).length, candidates: live.length, logged };
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
    if (t.pattern === 'P30') {
      const ht = goals(f, '1ST_HALF');
      if (ht && (FINISHED.test(state) || /HT|2ND|INPLAY_2ND|BREAK/i.test(state))) { hit = ht[0] + ht[1] > t.line ? 1 : 0; result = `HT ${ht[0]}-${ht[1]}`; }
    } else if (FINISHED.test(state)) {
      const ft = goals(f, '2ND_HALF') || goals(f, 'CURRENT');
      if (ft) { hit = ft[0] + ft[1] > t.line ? 1 : 0; result = `FT ${ft[0]}-${ft[1]}`; }
    }
    if (hit == null && (DEAD.test(state) || now - t.at > 4 * 3600)) { hit = -1; result = `void (${state || 'no result'})`; }
    if (hit == null) continue;
    await env.DB.prepare('UPDATE triggers SET hit = ?, result = ?, settled_at = ? WHERE id = ?').bind(hit, result, now, t.id).run();
    if (hit >= 0) await telegram(env, `${hit ? '✅' : '❌'} ${esc(t.home)} – ${esc(t.away)}: ${esc(PATTERNS[t.pattern].name)} · ${esc(result)}${t.best ? ` · price was ${Number(t.best).toFixed(2)}` : ''}`).catch(() => {});
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

export { match, overPrices, statsOf, run, summary };
