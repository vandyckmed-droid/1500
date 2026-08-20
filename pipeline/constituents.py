"""Fetch current constituents of the S&P 500, S&P MidCap 400 and S&P SmallCap 600.

Source: the Wikipedia constituent lists, which track S&P Dow Jones Indices
membership changes closely and are the standard free source for these lists.
"""
from __future__ import annotations

import io
import logging

import pandas as pd
import requests

log = logging.getLogger(__name__)

WIKI_PAGES = {
    "sp500": "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
    "sp400": "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
    "sp600": "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies",
}

INDEX_LABELS = {
    "sp500": "S&P 500",
    "sp400": "S&P MidCap 400",
    "sp600": "S&P SmallCap 600",
}

# Rough sanity bounds on member counts; membership drifts a little between
# rebalances so exact counts are not enforced.
EXPECTED_RANGE = {
    "sp500": (490, 510),
    "sp400": (390, 410),
    "sp600": (590, 610),
}

_HEADERS = {
    "User-Agent": "sp1500-momentum-pipeline/1.0 (github.com/vandyckmed-droid/1500)"
}


def _pick_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    cols = {str(c).strip().lower(): c for c in df.columns}
    for cand in candidates:
        if cand in cols:
            return cols[cand]
    return None


def _constituent_table(url: str) -> pd.DataFrame:
    resp = requests.get(url, headers=_HEADERS, timeout=60)
    resp.raise_for_status()
    tables = pd.read_html(io.StringIO(resp.text))
    best = None
    for t in tables:
        sym = _pick_column(t, ["symbol", "ticker", "ticker symbol"])
        if sym is None or len(t) < 100:
            continue
        if best is None or len(t) > len(best):
            best = t
    if best is None:
        raise RuntimeError(f"no constituent table found at {url}")
    return best


def fetch_index(index_key: str) -> pd.DataFrame:
    """Return DataFrame with columns: symbol, name, sector, index."""
    url = WIKI_PAGES[index_key]
    t = _constituent_table(url)
    sym_col = _pick_column(t, ["symbol", "ticker", "ticker symbol"])
    name_col = _pick_column(t, ["security", "company", "company name"])
    sector_col = _pick_column(t, ["gics sector", "sector"])

    out = pd.DataFrame(
        {
            "symbol": t[sym_col].astype(str).str.strip(),
            "name": t[name_col].astype(str).str.strip() if name_col else "",
            "sector": t[sector_col].astype(str).str.strip() if sector_col else "",
        }
    )
    out = out[out["symbol"].str.len() > 0]
    out = out.drop_duplicates(subset="symbol").reset_index(drop=True)
    out["index"] = index_key

    lo, hi = EXPECTED_RANGE[index_key]
    n = len(out)
    if not (lo <= n <= hi):
        raise RuntimeError(
            f"{index_key}: got {n} constituents, expected between {lo} and {hi}"
        )
    log.info("%s: %d constituents", index_key, n)
    return out


def fetch_all() -> pd.DataFrame:
    """Fetch all three indices and return the combined S&P 1500 frame.

    A symbol occasionally appears in two lists mid-rebalance; membership is kept
    from the larger-cap index in that case.
    """
    frames = [fetch_index(k) for k in ("sp500", "sp400", "sp600")]
    combined = pd.concat(frames, ignore_index=True)
    combined = combined.drop_duplicates(subset="symbol", keep="first").reset_index(drop=True)
    log.info("S&P 1500 combined: %d unique symbols", len(combined))
    return combined
