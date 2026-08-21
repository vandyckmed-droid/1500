"""Pipeline orchestrator.

Usage: python -m pipeline.run [--no-cache] [--output docs/data/rankings.json]

Steps: fetch constituents -> fetch adjusted price history -> compute metrics,
scores and ranks -> validate -> write the JSON consumed by the static site.
Exits non-zero if validation fails.
"""
from __future__ import annotations

import argparse
import math
import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from . import constituents as cons
from . import metrics, prices, validate

log = logging.getLogger("pipeline")

# ~13.5 months of calendar history comfortably covers 253 trading days.
HISTORY_DAYS = 420

# The shared daily-returns matrix for client-side portfolio math (basket
# volatility, beta, correlations, HRP): one global trading-day axis, this
# many return days deep — enough for the client's ~6-month windows.
RETURNS_DAYS = 130
RETURNS_SCALE = 10_000  # log returns stored as ints: round(ln(p1/p0) * 1e4)
RETURNS_MIN_OBS = 60  # symbols with fewer non-null returns are left out
RETURNS_MIN_COVERAGE = 0.95  # of ranked symbols, else the file is not written

TABLE_COLUMNS = [
    "symbol",
    "name",
    "sector",
    "index",
    "last_price",
    "last_date",
    "price_1m_ago",
    "date_1m_ago",
    "price_6m_ago",
    "date_6m_ago",
    "price_12m_ago",
    "date_12m_ago",
    "return_12_1",
    "return_6_1",
    "volatility_63d",
    "score_12",
    "score_6",
    "final_score",
    "alternative_score",
    "market_cap",
    "rank_index",
    "rank_sector",
    "rank_1500",
    "percentile_1500",
]


def build_returns_matrix(series: dict[str, pd.Series], ranked_syms: list[str]) -> dict | None:
    """One daily log-return matrix shared by all client-side portfolio math.

    A single global trading-day axis (union of ranked symbols' dates, last
    RETURNS_DAYS return days); per symbol, an int array of log returns
    scaled by RETURNS_SCALE, null where the symbol lacks either day's close.
    Returns None (caller logs and skips the file) if coverage is too thin —
    the file is additive, so a bad day for it must never block the rankings.
    """
    all_dates: set = set()
    for sym in ranked_syms:
        s = series.get(sym)
        if s is not None and not s.empty:
            all_dates.update(s.index)
    axis = sorted(all_dates)[-(RETURNS_DAYS + 1):]
    if len(axis) < RETURNS_MIN_OBS + 1:
        return None
    out: dict[str, list] = {}
    for sym in ranked_syms:
        s = series.get(sym)
        if s is None or s.empty:
            continue
        closes = {d: float(v) for d, v in s.items()}
        row: list = []
        n_obs = 0
        for i in range(1, len(axis)):
            p0, p1 = closes.get(axis[i - 1]), closes.get(axis[i])
            if p0 and p1 and p0 > 0 and p1 > 0:
                row.append(round(math.log(p1 / p0) * RETURNS_SCALE))
                n_obs += 1
            else:
                row.append(None)
        if n_obs >= RETURNS_MIN_OBS:
            out[sym] = row
    if len(out) < RETURNS_MIN_COVERAGE * len(ranked_syms):
        return None
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in axis[1:]],
        "scale": RETURNS_SCALE,
        "kind": "log",
        "returns": out,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-cache", action="store_true", help="ignore the local price cache")
    parser.add_argument("--output", default="docs/data/rankings.json")
    parser.add_argument(
        "--prices-dir",
        default="prices_out",
        help="directory for per-ticker price JSON (published to the 'data' "
        "branch by CI, not committed to main)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    log.info("fetching index constituents")
    members = cons.fetch_all()
    counts = members["index"].value_counts().to_dict()

    end = date.today()
    start = end - timedelta(days=HISTORY_DAYS)
    log.info("fetching adjusted prices %s .. %s for %d symbols", start, end, len(members))
    series, provider_used, failed = prices.fetch_history(
        members["symbol"].tolist(), start, end, use_cache=not args.no_cache
    )

    log.info("computing metrics and ranks")
    table, excluded = metrics.build_table(members, series)
    caps = prices.fetch_market_caps(table["symbol"].tolist())
    if not caps:
        # No keyed provider available: carry the previous run's caps forward
        # instead of wiping the column.
        try:
            prev = json.loads(Path(args.output).read_text())
            pi = {c: n for n, c in enumerate(prev["columns"])}
            caps = {
                r[pi["symbol"]]: r[pi["market_cap"]]
                for r in prev["rows"]
                if r[pi["market_cap"]]
            }
            log.info("carried forward %d market caps from previous output", len(caps))
        except (OSError, ValueError, KeyError):
            log.warning("no market caps available and no previous output to reuse")
    table["market_cap"] = table["symbol"].map(caps)

    errors = validate.validate(table, members)
    if errors:
        for e in errors:
            log.error("VALIDATION: %s", e)
        return 1

    provider_counts: dict[str, int] = {}
    for p in provider_used.values():
        provider_counts[p] = provider_counts.get(p, 0) + 1

    # Equal-weighted sector aggregates: every member counts 1/N, no cap
    # weighting. Ranked by the same Avg. VAR construction as single stocks.
    sec = (
        table[table["sector"] != ""]
        .groupby("sector")
        .agg(
            count=("symbol", "size"),
            return_12_1=("return_12_1", "mean"),
            return_6_1=("return_6_1", "mean"),
            volatility_63d=("volatility_63d", "mean"),
            score_12=("score_12", "mean"),
            score_6=("score_6", "mean"),
            final_score=("final_score", "mean"),
        )
        .reset_index()
    )
    sec["rank"] = sec["final_score"].rank(ascending=False, method="min").astype(int)
    sec = sec.sort_values("rank")
    num_cols = sec.columns.difference(["sector", "count", "rank"])
    sec[num_cols] = sec[num_cols].round(4)

    as_of = table["last_date"].value_counts().idxmax()
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": as_of,
        "constituent_counts": counts,
        "ranked_counts": table["index"].value_counts().to_dict(),
        "data_sources": provider_counts,
        "excluded": sorted(excluded, key=lambda x: (x["index"], x["symbol"])),
        "sectors": sec.to_dict("records"),
        "columns": TABLE_COLUMNS,
        # NaN/inf must become JSON null: pandas' .where(notna(), None) is a
        # no-op on float columns, so convert explicitly.
        "rows": [
            [
                None
                if (isinstance(v, float) and not math.isfinite(v)) or pd.isna(v)
                else v
                for v in row
            ]
            for row in table[TABLE_COLUMNS].values.tolist()
        ],
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False makes the pipeline fail loudly rather than ever
    # publishing NaN/Infinity literals, which are invalid JSON.
    blob = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    out.write_text(blob)
    # (Rank history is recorded by the Cloudflare Worker into D1 each morning;
    # no file snapshots are kept in the repo.)

    # The shared returns matrix (dark-launched: published alongside the
    # rankings, consumed by the app once the client math switches to it).
    matrix = build_returns_matrix(series, table["symbol"].tolist())
    ret_out = out.parent / "returns.json"
    if matrix is None:
        log.error("returns matrix coverage too thin — not writing %s", ret_out)
    else:
        matrix = {
            "generated_at": payload["generated_at"],
            "as_of": as_of,
            **matrix,
        }
        ret_out.write_text(json.dumps(matrix, separators=(",", ":"), allow_nan=False))
        log.info(
            "wrote %s: %d symbols x %d days",
            ret_out,
            len(matrix["returns"]),
            len(matrix["dates"]),
        )

    # Per-ticker price series for the site's charts. These are large and
    # regenerated whole every day, so they live on the orphan 'data' branch
    # (force-pushed by CI) instead of polluting main's history.
    prices_dir = Path(args.prices_dir)
    prices_dir.mkdir(parents=True, exist_ok=True)
    ranked_syms = set(table["symbol"])
    for sym, s in series.items():
        if sym not in ranked_syms:
            continue
        prices_dir.joinpath(f"{sym.replace('.', '_')}.json").write_text(
            json.dumps(
                {
                    "symbol": sym,
                    "dates": [d.strftime("%Y-%m-%d") for d in s.index],
                    "close": [round(float(v), 4) for v in s],
                },
                separators=(",", ":"),
            )
        )
    log.info("wrote %d price series to %s", len(ranked_syms), prices_dir)
    log.info(
        "wrote %s: %d ranked, %d excluded, as of %s",
        out,
        len(table),
        len(excluded),
        as_of,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
