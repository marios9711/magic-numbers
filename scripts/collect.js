// Daily collector: saves yesterday's, today's and tomorrow's fixtures (all competitions).
// The free API plan only allows this 3-day window, so it must run every day.
const path = require('path');
const { ROOT, api, compact, writeJSON } = require('./lib');

const day = off => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);

(async () => {
  let failed = 0;
  for (const d of [day(-1), day(0), day(1)]) {
    try {
      const rows = (await api(`/fixtures?date=${d}`)).map(compact);
      writeJSON(path.join(ROOT, 'data/days', `${d}.json`), { date: d, fetched: new Date().toISOString(), rows });
      console.log(`${d}: ${rows.length} fixtures saved`);
    } catch (e) {
      failed++;
      console.error(`${d}: ${e.message}`);
    }
  }
  if (failed === 3) process.exit(1);
})();
