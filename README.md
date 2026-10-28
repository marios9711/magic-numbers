# Magic Numbers Predictions

Tests the method from *Οι μαγικοί αριθμοί του ποδοσφαίρου* (Κώστας Μπέζας) on real football matches worldwide.

- **Daily job** (`.github/workflows/daily.yml`, twice a day): downloads yesterday's results and today's and tomorrow's fixtures from API-Football (all leagues and cups, 3 requests per run) and rebuilds the predictions.
- **Website** (GitHub Pages, `docs/`): upcoming predictions, settled results, live hit rate vs simple baselines, a 2022–2024 backtest, a calculator and the method.
- **Backtest job** (`.github/workflows/backtest.yml`): downloads 42 leagues × 2022–2024 seasons (80 requests per day until complete) and runs the same method on them. Leagues are listed in `config.json`.

Requires the repository secret `APIFOOTBALL_KEY`.

## Notes

- Free API plan: 100 requests/day, dates limited to yesterday/today/tomorrow, past seasons 2022–2024. Live predictions need a warm-up of ~6–8 weeks until teams have 7 recorded matches.
- A team needs at least 7 recorded matches (all competitions, friendlies excluded) to be predicted. Results are judged on the 90-minute score.
- The rules are an interpretation of the book; weights live in `docs/engine.js`.
- Research tool, not betting advice.
