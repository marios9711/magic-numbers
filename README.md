# Magic Numbers Predictions

Tests the method from *Οι μαγικοί αριθμοί του ποδοσφαίρου* (Κώστας Μπέζας) on real football matches worldwide, next to statistical models and real bookmaker prices.

- **Daily job** (`.github/workflows/daily.yml`, 04:23 and 15:23 UTC): downloads yesterday's results and today's and tomorrow's fixtures from API-Football (3 requests), Bet365 odds for today and tomorrow (up to 20 requests), best prices across all bookmakers for the shortlisted Top 3 candidates (up to 10 requests), and rebuilds the site. About 66 requests a day at most.
- **Website** (GitHub Pages, `docs/`): Daily Top 3, upcoming predictions, results, live performance, paper betting (with likely-range verdicts), a 2022–2024 backtest, a calculator and the method.
- **Backtest job** (`.github/workflows/backtest.yml`): downloaded 42 leagues × 2022–2024 seasons into `data/seasons/` (finished; now uses 0 requests). Leagues are listed in `config.json`.
- **One-off jobs** (run manually from the Actions tab): `history.yml` downloads historical bookmaker odds from football-data.co.uk into `data/hist/` (no API-Football requests); `probe.yml` checks which bookmakers the API offers (2 requests).

Requires the repository secret `APIFOOTBALL_KEY`.

## Scripts

- `scripts/collect.js`, `odds.js`, `shop.js`: data collection. `markets.js`: shared bookmaker-odds parser.
- `scripts/build.js`: predictions, Top 3, paper betting and statistics into `docs/data/`.
- `docs/engine.js`: the book's method. `scripts/ratings.js`: opponent-adjusted team ratings (1X2 and goal-line chances). `scripts/goals.js`: Over/Under model, value checks and margin removal (power method).

## Notes

- Free API plan: 100 requests/day (max 10 a minute), dates limited to yesterday/today/tomorrow, past seasons 2022–2024. Teams need 6–7 recorded matches before they are predicted, so live predictions need a warm-up of a few weeks.
- Results are judged on the 90-minute score. Friendlies are excluded.
- Tested against real historical prices, no model here beats the bookmaker on its own; see the Method tab. Research tool, not betting advice.
