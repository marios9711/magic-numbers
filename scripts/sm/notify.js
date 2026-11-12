// Telegram messages for the daily slip: new picks as soon as they are logged, and results once
// they are graded. Needs the GitHub secrets TG_TOKEN (bot token from @BotFather) and TG_CHAT
// (chat id); without them it does nothing. Remembers what was sent in data/sm/notified.json.
const S = require('./smlib');

const TOKEN = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
const NAMES = { win: 'Win', over25: 'Over 2.5', ht15: '1st-half over 1.5' };
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const time = ts => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Bucharest', weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return j.result && j.result.message_id;
}

(async () => {
  if (!TOKEN || !CHAT) { console.log('notify.js: TG_TOKEN / TG_CHAT not set — skipping.'); return; }
  const picks = S.readJSON(S.p('picks.json'), { picks: [] }).picks;
  const done = S.readJSON(S.p('notified.json'), { picks: [], results: [] });
  const sentP = new Set(done.picks), sentR = new Set(done.results);
  // Telegram message id of the slip message each pick was in (the live logger replies to it with
  // the line-up check). Published with the site so the logger can read it.
  const msgFile = S.p('../../docs/data/sm/tgmsg.json'), msgIds = S.readJSON(msgFile, {});

  const fresh = picks.filter(p => !sentP.has(p.id) && p.ts > S.now()).sort((a, b) => a.ts - b.ts);
  if (fresh.length) {
    const day = new Date(fresh[0].day + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const lines = [`🧾 <b>Daily slip ${esc(day)}</b>`];
    for (const g of Object.keys(NAMES)) {
      const ps = fresh.filter(p => p.grp === g);
      if (!ps.length) continue;
      lines.push(`\n<b>${NAMES[g]}</b>`);
      for (const p of ps) {
        // Short format (Marios's choice): match, pick and price only. Details stay on the site.
        lines.push(`• ${time(p.ts)} ${esc(p.hn)} – ${esc(p.an)}\n   ${esc(S.label(p.key, p.hn, p.an))} @ <b>${p.odds.toFixed(2)}</b>`
          + (p.warn ? `\n   ⚠️ ${esc(p.warn)}` : ''));
      }
    }
    const mid = await send(lines.join('\n'));
    for (const p of fresh) { sentP.add(p.id); if (mid) msgIds[p.id] = mid; }
  }

  // Results the live logger already sent (it grades slip picks every 2 minutes) are not repeated here.
  const live = S.readJSON(S.p('../../docs/data/sm/live.json'), {});
  for (const r of live.slipres || []) if (r.sent) sentR.add(r.pid);
  const graded = picks.filter(p => p.r != null && !sentR.has(p.id));
  if (graded.length) {
    const lines = ['📊 <b>Results</b>'];
    for (const p of graded.slice(0, 25)) {
      const sc = p.grp === 'ht15' ? (String(p.score).match(/HT \d+-\d+/) || [p.score])[0] : String(p.score).split(' (')[0];
      lines.push(`${p.r > 0 ? '✅' : p.r < 0 ? '❌' : '➖'} ${esc(p.hn)} – ${esc(p.an)}: ${esc(S.label(p.key, p.hn, p.an))} (${esc(sc)})`);
    }
    await send(lines.join('\n'));
    for (const p of graded) sentR.add(p.id);
  }

  S.writeJSON(msgFile, Object.fromEntries(Object.entries(msgIds).slice(-500)));
  S.writeJSON(S.p('notified.json'), { picks: [...sentP].slice(-3000), results: [...sentR].slice(-3000) });
  console.log('notify.js', JSON.stringify({ newPicks: fresh.length, results: graded.length }));
})().catch(e => { console.error('notify.js failed:', e.message); process.exitCode = 1; });
