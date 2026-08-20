"""Momentum and volatility metrics.

Window conventions (trading days):
- 1 month  = 21 trading days
- 6 months = 126 trading days
- 12 months = 252 trading days

Returns:
- return_12_1: price 21 trading days ago vs. price 252 trading days ago
  (i.e. the 12-month return excluding the most recent month).
- return_6_1: price 21 trading days ago vs. price 126 trading days ago.

Volatility:
- std of daily simple returns over the trailing 252 (or 126) trading days,
  annualized with sqrt(252). Sample std (ddof=1).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

MONTH = 21
HALF_YEAR = 126
YEAR = 252

MIN_OBS_6M = 120


def compute_symbol_metrics(prices: pd.Series) -> dict | None:
    """Compute all metrics for one adjusted-close series.

    Returns None if there is not enough history for even the 6-month metrics.
    """
    p = prices.dropna()
    n = len(p)
    if n < MIN_OBS_6M + MONTH:
        return None

    last_price = float(p.iloc[-1])
    p_1m = float(p.iloc[-1 - MONTH])
    daily = p.pct_change().dropna()

    out: dict = {
        "last_price": round(last_price, 4),
        "last_date": p.index[-1].strftime("%Y-%m-%d"),
        "n_obs": n,
        # anchor prices/dates so the site can show exactly how each number
        # was computed
        "price_1m_ago": round(p_1m, 4),
        "date_1m_ago": p.index[-1 - MONTH].strftime("%Y-%m-%d"),
    }

    # 6-month metrics (guard above guarantees n > HALF_YEAR + MONTH)
    idx_6 = -1 - HALF_YEAR
    p_6m = float(p.iloc[idx_6])
    out["price_6m_ago"] = round(p_6m, 4)
    out["date_6m_ago"] = p.index[idx_6].strftime("%Y-%m-%d")
    out["return_6_1"] = p_1m / p_6m - 1.0
    vol_6 = float(daily.iloc[-HALF_YEAR:].std(ddof=1)) * math.sqrt(YEAR)
    out["volatility_6m"] = vol_6

    # 12-month metrics: require a genuine 252-trading-day lookback so the
    # 12-1 window is never silently shortened for young listings.
    if n >= YEAR + 1:
        idx_12 = n - 1 - YEAR
        p_12m = float(p.iloc[idx_12])
        out["price_12m_ago"] = round(p_12m, 4)
        out["date_12m_ago"] = p.index[idx_12].strftime("%Y-%m-%d")
        out["return_12_1"] = p_1m / p_12m - 1.0
        vol_12 = float(daily.iloc[-YEAR:].std(ddof=1)) * math.sqrt(YEAR)
        out["volatility_12m"] = vol_12
    else:
        out["price_12m_ago"] = None
        out["date_12m_ago"] = None
        out["return_12_1"] = None
        out["volatility_12m"] = None

    def _score(ret, vol):
        if ret is None or vol is None or vol <= 0 or not math.isfinite(vol):
            return None
        return ret / vol

    out["score_6"] = _score(out["return_6_1"], out["volatility_6m"])
    out["score_12"] = _score(out["return_12_1"], out["volatility_12m"])

    if out["score_6"] is not None and out["score_12"] is not None:
        out["final_score"] = 0.5 * out["score_12"] + 0.5 * out["score_6"]
        avg_ret = (out["return_12_1"] + out["return_6_1"]) / 2.0
        avg_vol = (out["volatility_12m"] + out["volatility_6m"]) / 2.0
        out["alternative_score"] = avg_ret / avg_vol if avg_vol > 0 else None
    else:
        out["final_score"] = None
        out["alternative_score"] = None

    return out


def build_table(
    constituents: pd.DataFrame, series: dict[str, pd.Series]
) -> tuple[pd.DataFrame, list[dict]]:
    """Compute metrics for every constituent and rank them.

    Returns (ranked DataFrame, list of excluded symbols with reasons).
    """
    rows = []
    excluded = []
    for rec in constituents.to_dict("records"):
        sym = rec["symbol"]
        s = series.get(sym)
        if s is None or s.empty:
            excluded.append({"symbol": sym, "index": rec["index"], "reason": "no price data"})
            continue
        m = compute_symbol_metrics(s)
        if m is None:
            excluded.append(
                {"symbol": sym, "index": rec["index"], "reason": f"insufficient history ({len(s)} obs)"}
            )
            continue
        if m["final_score"] is None:
            excluded.append(
                {
                    "symbol": sym,
                    "index": rec["index"],
                    "reason": f"incomplete 12m history ({m['n_obs']} obs)",
                }
            )
            continue
        rows.append({**rec, **m})

    df = pd.DataFrame(rows)
    if df.empty:
        return df, excluded

    # Ranks: 1 = highest final_score.
    df["rank_1500"] = (
        df["final_score"].rank(ascending=False, method="min").astype(int)
    )
    df["rank_index"] = (
        df.groupby("index")["final_score"]
        .rank(ascending=False, method="min")
        .astype(int)
    )
    df["rank_sector"] = (
        df.groupby("sector")["final_score"]
        .rank(ascending=False, method="min")
        .astype(int)
    )
    df["percentile_1500"] = (
        df["final_score"].rank(pct=True).mul(100).round(1)
    )
    df = df.sort_values("rank_1500").reset_index(drop=True)

    numeric = [
        "return_12_1",
        "return_6_1",
        "volatility_12m",
        "volatility_6m",
        "score_12",
        "score_6",
        "final_score",
        "alternative_score",
    ]
    df[numeric] = df[numeric].astype(float).replace([np.inf, -np.inf], np.nan).round(4)
    return df, excluded
