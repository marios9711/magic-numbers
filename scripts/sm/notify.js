// Telegram messages for the daily slip: new picks as soon as they are logged, and results once
// they are graded. Needs the GitHub secrets TG_TOKEN (bot token from @BotFather) and TG_CHAT
// (chat id); without them it does nothing. Remembers what was sent in data/sm/notified.json.
const S = require('./smlib');

const TOKEN = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
const NAMES = { win: 'Win', over25: 'Over 2.5', ht15: '1st-half over 1.5' };
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const time = ts => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Bucharest', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const pct = x => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

(async () => {
  if (!TOKEN || !CHAT) { console.log('notify.js: TG_TOKEN / TG_CHAT not set — skipping.'); return; }
  const picks = S.readJSON(S.p('picks.json'), { picks: [] }).picks;
  const st = S.loadState();
  const lg = id => { const L = st.leagues[id]; return L ? `${L.country ? L.country + ' · ' : ''}${L.name}` : ''; };
  const done = S.readJSON(S.p('notified.json'), { picks: [], results: [] });
  const sentP = new Set(done.picks), sentR = new Set(done.results);

  const fresh = picks.filter(p => !sentP.has(p.id) && p.ts > S.now()).sort((a, b) => a.ts - b.ts);
  if (fresh.length) {
    const lines = [`🧾 <b>Daily slip ${esc(fresh[0].day)}</b> — ${fresh.length} new pick${fresh.length > 1 ? 's' : ''} (singles, paper only)`];
    for (const g of Object.keys(NAMES)) {
      const ps = fresh.filter(p => p.grp === g);
      if (!ps.length) continue;
      lines.push(`\n<b>${NAMES[g]}</b>`);
      for (const p of ps) {
        lines.push(`• ${time(p.ts)} ${esc(p.hn)} – ${esc(p.an)} <i>(${esc(lg(p.lg))})</i>\n   ${esc(S.label(p.key, p.hn, p.an))} @ <b>${p.odds.toFixed(2)}</b> ${esc(p.book)} · chance ${pct(p.fair0)} · edge +${(p.edge0 * 100).toFixed(1)}%${p.rules ? ' · motivation' : ''}`);
      }
    }
    await send(lines.join('\n'));
    for (const p of fresh) sentP.add(p.id);
  }

  const graded = picks.filter(p => p.r != null && !sentR.has(p.id));
  if (graded.length) {
    const profit = graded.reduce((s, p) => s + (p.profit || 0), 0);
    const all = picks.filter(p => p.r != null), tot = all.reduce((s, p) => s + (p.profit || 0), 0);
    const lines = [`📊 <b>Results</b> — ${graded.filter(p => p.r > 0).length}/${graded.length} won, ${profit >= 0 ? '+' : '−'}€${Math.abs(profit).toFixed(2)} (€10 a pick)`];
    for (const p of graded.slice(0, 25)) lines.push(`${p.r > 0 ? '✅' : p.r < 0 ? '❌' : '➖'} ${esc(p.hn)} – ${esc(p.an)} ${esc(p.score)} · ${esc(S.label(p.key, p.hn, p.an))} @ ${p.odds.toFixed(2)}`);
    lines.push(`\nSo far: ${all.length} graded, ${all.length ? Math.round(all.filter(p => p.r > 0).length / all.length * 100) : 0}% won, ${tot >= 0 ? '+' : '−'}€${Math.abs(tot).toFixed(2)}`);
    await send(lines.join('\n'));
    for (const p of graded) sentR.add(p.id);
  }

  S.writeJSON(S.p('notified.json'), { picks: [...sentP].slice(-3000), results: [...sentR].slice(-3000) });
  console.log('notify.js', JSON.stringify({ newPicks: fresh.length, results: graded.length }));
})().catch(e => { console.error('notify.js failed:', e.message); process.exitCode = 1; });
