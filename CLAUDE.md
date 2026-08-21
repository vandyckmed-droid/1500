# S&P 1500 Momentum — conventions

Risk-adjusted momentum rankings for the S&P Composite 1500, published as a
static PWA (docs/) fronted by a Cloudflare Worker (worker/index.js), with a
nightly Python pipeline (pipeline/). Design identity: a printed research
note — warm paper, near-black ink, hairline rules, Fraunces for headings,
IBM Plex Mono for every number, two accent inks (green = favorable/less
risk, oxblood = adverse/more risk) on data marks only. No boxes, shadows,
or gradients; hierarchy comes from type weight, whitespace, and thin rules.

## The one set of statistical conventions

Windows are trading days: 1m = 21, 3m = 63, 6m = 126, 1y = 252.

- **Ranking (pipeline/metrics.py)**: `return_12_1` and `return_6_1` skip the
  latest month; `volatility_63d` = sample std (ddof=1) of the last 63 daily
  *simple* returns × √252; scores annualize returns (×252/window) and floor
  the vol denominator at 20% (`VOL_FLOOR`); names with 21-day vol < 6%
  (`PINNED_VOL21`) are excluded as acquisition-pinned.
- **Client portfolio math (docs/stats.js)**: *log* returns from the shared
  returns matrix, at least `MIN_OVERLAP` (40) common dates for any
  correlation or beta; volatilities annualized with √252, ddof=1. HRP uses
  the last 126 overlapping days. `volFromCloses` reproduces the pipeline's
  simple-return formula and is the reconciliation anchor.
- **The returns matrix (docs/data/returns.json)**: emitted nightly by
  pipeline/run.py — one global trading-day axis (last 130 return days),
  per-symbol log returns × 1e4 as ints, null where a close is missing.
  All client basket/beta/correlation/HRP math reads this one file. The
  per-symbol price archive (the `data` branch) exists for charts and
  momentum quality, which need 252-day closes.

Never introduce a second convention. If a feature needs a different window,
add it here first.

## Cache invalidation (docs/index.html)

Watchlist edits (`saveWatch`) and weight-scheme changes invalidate together:
`HRPW`, `PSTAT`, `BASKET`, `BETA`, plus a `basketRun` bump so in-flight
basket computations can never write stale results. `BETA` is keyed by
`BASKET.key` (sorted symbols + scheme). The matrix itself (`MATRIX`) is
fetched once per session; per-symbol maps derive from it in `RETS`.
Async completions repaint through `scheduleRender()` (rAF-coalesced),
never `render(true)` directly.

## Tests and gates

Every PR must pass `.github/workflows/checks.yml`:

```bash
node --check worker/index.js docs/stats.js        # syntax
node --test test/stats.test.js test/contrast.test.js   # math + WCAG palettes
python3 test/check_data.py docs/data/rankings.json     # schema + matrix reconciliation
npx wrangler deploy --dry-run                          # bundle/config
python3 -m http.server 8080 --directory docs &
node test/smoke.spec.js                                # headless boot-to-beta smoke
```

The smoke stubs every network dependency deterministically and also
enforces the boot-weight budget (shell < 320 KB uncompressed) and that the
self-hosted fonts load. The reconciliation tests pin the JS formulas to the
pipeline's published numbers — keep them green rather than loosening
tolerances.

## Deploy flow

Push to `main` → Cloudflare Workers Builds deploys the Worker + assets;
GitHub Actions (update.yml) also redeploys the Pages mirror. The nightly
data run (05:30 UTC Tue–Sat) refetches prices, validates, commits
`docs/data/` and force-pushes the price archive to the orphan `data`
branch. A failed validation publishes nothing and leaves the previous data
live. Branch pushes get a preview at
`claude-<branch>-1500.vandyck-med.workers.dev`.

Development happens on a work branch merged to `main` by squash; after each
squash-merge, rebuild the branch from `origin/main` (`git checkout -B
<branch> origin/main`) before the next change — stacking on pre-squash
history causes conflicts.

## What not to do

- No frameworks, no build step: docs/index.html is one page plus stats.js.
- No third-party runtime dependency beyond Yahoo (quotes) — fonts are
  vendored, and the earnings/Nasdaq experiment was removed deliberately.
- Accent colors never appear on chrome — data marks only. The contrast test
  will fail any palette change that breaks WCAG.
- Don't add API endpoints without a caller in the app; the Snack-era
  endpoints were deleted for a reason.
