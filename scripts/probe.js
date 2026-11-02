// One-off check (2 API requests): which bookmakers API-Football offers on our plan (is Pinnacle
// there?) and what an all-bookmakers odds page costs. Writes data/probe.json for review.
const path = require('path');
const { ROOT, writeJSON } = require('./lib');
const get = async url => {
  const r = await fetch('https://v3.football.api-sports.io' + url, { headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY } });
  return r.json();
};
(async () => {
  const out = { at: new Date().toISOString() };
  try {
    const b = await get('/odds/bookmakers');
    out.bookmakers = (b.response || []).map(x => `${x.id}:${x.name}`);
    out.pinnacle = (b.response || []).filter(x => /pinnacle/i.test(x.name)).map(x => x.id);
    out.bookErrors = b.errors;
  } catch (e) { out.bookErr = e.message; }
  await new Promise(r => setTimeout(r, 7000));
  try {
    const d = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const o = await get(`/odds?date=${d}&page=1`);
    const resp = o.response || [];
    out.allBooks = {
      date: d, paging: o.paging, results: o.results, fixturesOnPage: resp.length, errors: o.errors,
      booksPerFixture: resp.map(f => (f.bookmakers || []).length),
      withPinnacle: resp.filter(f => (f.bookmakers || []).some(b => /pinnacle/i.test(b.name))).length,
      sampleBooks: resp[0] ? (resp[0].bookmakers || []).map(b => b.name) : [],
    };
  } catch (e) { out.oddsErr = e.message; }
  writeJSON(path.join(ROOT, 'data/probe.json'), out);
  console.log(JSON.stringify(out).slice(0, 2000));
})();
