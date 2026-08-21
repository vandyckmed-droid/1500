# S&P 1500 Momentum Rankings

Automated risk-adjusted momentum rankings for the **S&P Composite 1500**
(S&P 500 + S&P MidCap 400 + S&P SmallCap 600), published as a static site via
GitHub Pages and refreshed automatically with GitHub Actions.

**Live site:** https://vandyckmed-droid.github.io/1500/

## Methodology

1. **Universe** — current constituents of the S&P 500, S&P MidCap 400 and
   S&P SmallCap 600, from the Wikipedia constituent lists.
2. **Prices** — ~13 months of daily dividend/split-adjusted closes per security.
3. **Returns** (trading-day windows: 1m = 21, 6m = 126, 12m = 252 days)
   - `return_12_1` = P(t−21) / P(t−252) − 1 — 12-month return excluding the most recent month
   - `return_6_1` = P(t−21) / P(t−126) − 1 — 6-month return excluding the most recent month
4. **Volatility** — one measure throughout: sample std of daily adjusted
   returns over the trailing 63 trading days (~3 months), annualized:
   `volatility_63d = std(daily_returns) × sqrt(252)`.
5. **Scores** — returns are annualized to match the annualized volatility
   (the 12-1 window spans 231 trading days, the 6-1 window 105), so both
   scores share the same reward-per-risk units and the composite weights the
   two horizons equally:
   - `score_12 = (return_12_1 × 252/231) / volatility_63d`
   - `score_6 = (return_6_1 × 252/105) / volatility_63d`
   - **`final_score = 0.50 × score_12 + 0.50 × score_6`** (primary ranking)
   - `alternative_score = ((return_12_1 + return_6_1)/2) / volatility_63d` (retained)
6. **Ranks** — within each index and across the full S&P 1500 (rank 1 = best).
   Securities without a complete 12-month history are excluded and listed in the
   data file under `excluded`.

## Data sources

The primary price source is a keyed market-data provider configured through the
`API_KEY` environment variable (the provider is auto-detected from the key at
runtime; set `PRICE_PROVIDER` to pin one of `alphavantage`, `tiingo`, `fmp`,
`polygon`, `eodhd`, `twelvedata`, `finnhub`). If the key cannot serve daily
adjusted history for the full universe (e.g. a free Alpha Vantage key, whose
daily-adjusted endpoint is premium-only), the pipeline falls back to keyless
sources (Yahoo Finance chart API, then Stooq), so it always produces a
ranking. Each row records which source served it, and the per-source counts
are shown on the site.

## Running locally

```bash
pip install -r requirements.txt
API_KEY=... python -m pipeline.run
```

Output is written to `docs/data/rankings.json`, which `docs/index.html` renders
client-side. Prices are cached under `data_cache/` per end-date; use
`--no-cache` to force a refetch.

## Automation

`.github/workflows/update.yml` runs each weekday night (05:30 UTC Tue–Sat,
after the US close) and on manual dispatch: it fetches constituents and prices,
recomputes the rankings, runs validation checks (coverage per index, value
sanity bounds, rank integrity), commits the updated `docs/data/rankings.json`,
and deploys `docs/` to GitHub Pages. A push to `main` redeploys the site
without refreshing data. If validation fails, nothing is committed or deployed
and the previous site stays up.

To let CI use the keyed provider, add a repository **Actions secret** named
`API_KEY` (Settings → Secrets and variables → Actions). Without it, CI uses the
keyless fallbacks.

## Disclaimer

For research purposes only; not investment advice. Data may contain errors and
is provided as-is.
