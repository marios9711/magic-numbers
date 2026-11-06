// Sharp reference prices: Pinnacle (and Betfair Exchange) 1X2 + Over/Under 2.5 from The Odds API
// (the-odds-api.com, free plan: 500 credits a month). football-data.co.uk's current files carry no
// Pinnacle prices, and Pinnacle's margin-free price was the best benchmark in the 2022–24 tests
// (best price x Pinnacle fair chance >= 1.04: +11.0% in 2024, +6.5% over 2022–24; not proven).
//
// Cost: one odds call = 2 credits (2 markets x 1 region) per league. The /sports and /events
// calls are free; if an events call ever turns out to cost credits, the script stops using them.
// The per-run budget spreads the remaining monthly credits evenly over the runs left this month.
// Writes data/sharp.json: { events: { id: { code, ts, home, away, first, last } }, usage, log }.
// Matching to football-data rows happens in scripts/fdsource.js.
const path = require('path');
const { ROOT, readJSON, writeJSON } = require('./lib');

const KEY = process.env.ODDSAPI_KEY;
const BASE = 'https://api.the-odds-api.com/v4';
const RUNS_PER_DAY = 2;            // fdco.yml runs twice a day
const WINDOW_H = 36;               // only leagues with a match in the next 36 hours
const COST = 2;                    // h2h + totals, one region
// football-data code -> The Odds API sport key, in priority order (spent first when credits are short).
const SPORTS = [
  ['E0', 'soccer_epl'], ['SP1', 'soccer_spain_la_liga'], ['I1', 'soccer_italy_serie_a'], ['D1', 'soccer_germany_bundesliga'],
  ['F1', 'soccer_france_ligue_one'], ['N1', 'soccer_netherlands_eredivisie'], ['P1', 'soccer_portugal_primeira_liga'],
  ['E1', 'soccer_efl_champ'], ['B1', 'soccer_belgium_first_div'], ['T1', 'soccer_turkey_super_league'], ['SC0', 'soccer_spl'],
  ['G1', 'soccer_greece_super_league'], ['D2', 'soccer_germany_bundesliga2'], ['I2', 'soccer_italy_serie_b'],
  ['SP2', 'soccer_spain_segunda_division'], ['F2', 'soccer_france_ligue_two'], ['E2', 'soccer_england_league1'],
  ['E3', 'soccer_england_league2'], ['AUT', 'soccer_austria_bundesliga'], ['SWZ', 'soccer_switzerland_superleague'],
  ['DNK', 'soccer_denmark_superliga'], ['POL', 'soccer_poland_ekstraklasa'], ['SWE', 'soccer_sweden_allsvenskan'],
  ['NOR', 'soccer_norway_eliteserien'], ['BRA', 'soccer_brazil_campeonato'], ['ARG', 'soccer_argentina_primera_division'],
  ['USA', 'soccer_usa_mls'], ['MEX', 'soccer_mexico_ligamx'], ['JPN', 'soccer_japan_j_league'], ['CHN', 'soccer_china_superleague'],
  ['IRL', 'soccer_league_of_ireland'],
];
const FILE = path.join(ROOT, 'data/sharp.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(p, params = {}) {
  const q = new URLSearchParams({ apiKey: KEY, ...params });
  const res = await fetch(`${BASE}${p}?${q}`);
  const used = Number(res.headers.get('x-requests-used')), left = Number(res.headers.get('x-requests-remaining'));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${p}: ${(await res.text()).slice(0, 200)}`);
  return { data: await res.json(), used: Number.isFinite(used) ? used : null, left: Number.isFinite(left) ? left : null };
}

// One bookmaker's prices -> { '1', 'X', '2', 'O2.5', 'U2.5' }
function prices(bm, home, away) {
  const m = {};
  for (const mk of bm.markets || []) {
    if (mk.key === 'h2h') for (const o of mk.outcomes) { const k = o.name === home ? '1' : o.name === away ? '2' : o.name === 'Draw' ? 'X' : null; if (k && o.price > 1) m[k] = o.price; }
    if (mk.key === 'totals') for (const o of mk.outcomes) if (o.point === 2.5 && o.price > 1) m[o.name === 'Over' ? 'O2.5' : 'U2.5'] = o.price;
  }
  return Object.keys(m).length ? m : null;
}

(async () => {
  const store = readJSON(FILE, { events: {} }), now = Math.floor(Date.now() / 1000);
  for (const id in store.events) if (now - store.events[id].ts > 60 * 864e2) delete store.events[id];
  const log = { at: new Date().toISOString(), called: [], skipped: [], errors: [] };
  if (!KEY) { log.errors.push('ODDSAPI_KEY secret is not set — skipped'); store.log = log; writeJSON(FILE, store); console.log(log.errors[0]); return; }
  try {
    const sp = await call('/sports');
    const active = new Set(sp.data.filter(s => s.active).map(s => s.key));
    let left = sp.left, eventsFree = true;
    // Credits for this run: what is left, spread over the runs left this calendar month.
    const d = new Date(), daysLeft = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1;
    let budget = left == null ? COST * 4 : Math.floor(left / (daysLeft * RUNS_PER_DAY));
    log.budget = budget; log.leftAtStart = left;
    for (const [code, sport] of SPORTS) {
      if (!active.has(sport)) { log.skipped.push(`${code}: not offered`); continue; }
      if (budget < COST) { log.skipped.push(`${code}: no credits left this run`); continue; }
      if (eventsFree) { // free check: any match in the next WINDOW_H hours?
        const ev = await call(`/sports/${sport}/events`);
        if (ev.used != null && sp.used != null && ev.used > sp.used) { eventsFree = false; budget -= ev.used - sp.used; sp.used = ev.used; }
        const soon = ev.data.filter(e => { const t = Date.parse(e.commence_time) / 1000; return t > now && t < now + WINDOW_H * 3600; });
        if (!soon.length) { log.skipped.push(`${code}: no match in ${WINDOW_H} h`); await sleep(500); continue; }
      }
      const r = await call(`/sports/${sport}/odds`, { regions: 'eu', markets: 'h2h,totals', bookmakers: 'pinnacle,betfair_ex_eu', oddsFormat: 'decimal' });
      budget -= COST; left = r.left; if (r.used != null) sp.used = r.used; // so the next events check compares against this call
      let n = 0;
      for (const e of r.data) {
        const ts = Math.floor(Date.parse(e.commence_time) / 1000); if (ts <= now) continue; // before kick-off only
        const pin = e.bookmakers.find(b => b.key === 'pinnacle'), bfx = e.bookmakers.find(b => b.key === 'betfair_ex_eu');
        const snap = { at: now, pin: pin ? prices(pin, e.home_team, e.away_team) : null, bfx: bfx ? prices(bfx, e.home_team, e.away_team) : null };
        if (!snap.pin && !snap.bfx) continue;
        const prev = store.events[e.id];
        store.events[e.id] = { code, ts, home: e.home_team, away: e.away_team, first: prev ? prev.first : snap, last: snap }; n++;
      }
      log.called.push(`${code}: ${n} matches`);
      await sleep(500);
    }
    log.leftAtEnd = left;
  } catch (e) { log.errors.push(e.message); }
  store.log = log; writeJSON(FILE, store);
  console.log(JSON.stringify(log));
})();
