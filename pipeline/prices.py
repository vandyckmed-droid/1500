"""Historical adjusted daily close prices for the pipeline.

The primary source is a keyed market-data provider. The provider is not named
in configuration — only an ``API_KEY`` environment variable is supplied — so on
first use the pipeline detects which supported provider the key belongs to and
caches that choice. If no keyed provider is usable, keyless fallbacks (Yahoo
Finance chart API, then Stooq) keep the pipeline functional.

All providers return a pandas Series of adjusted close prices indexed by date.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

log = logging.getLogger(__name__)

CACHE_DIR = Path(os.environ.get("PRICE_CACHE_DIR", "data_cache"))
DETECTION_SYMBOL = "AAPL"
MIN_ROWS_VALID = 30  # a detection/fetch result with fewer rows is treated as failure


class RateLimiter:
    """Minimal cross-thread spacing between requests to one provider."""

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self._next_at - now
            self._next_at = max(now, self._next_at) + self.min_interval
        if delay > 0:
            time.sleep(delay)


def _series(rows: list[tuple[str, float]]) -> pd.Series:
    if not rows:
        return pd.Series(dtype=float)
    s = pd.Series(dict(rows), dtype=float)
    s.index = pd.to_datetime(s.index)
    s = s[s > 0].sort_index()
    # collapse duplicate dates if a provider repeats one
    s = s[~s.index.duplicated(keep="last")]
    return s


class Provider:
    name = "base"
    needs_key = True
    min_interval = 0.15
    workers = 8

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key
        self.limiter = RateLimiter(self.min_interval)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "sp1500-momentum-pipeline/1.0"

    def map_symbol(self, symbol: str) -> str:
        """Convert Wikipedia-style symbols (BRK.B) to this provider's format."""
        return symbol.replace(".", "-")

    def fetch(self, symbol: str, start: date, end: date) -> pd.Series:
        raise NotImplementedError

    def _get_json(self, url: str, params: dict | None = None):
        self.limiter.wait()
        resp = self.session.get(url, params=params, timeout=45)
        if resp.status_code == 429:
            raise RateLimited()
        resp.raise_for_status()
        return resp.json()


class RateLimited(Exception):
    pass


class Tiingo(Provider):
    name = "tiingo"

    def fetch(self, symbol, start, end):
        url = f"https://api.tiingo.com/tiingo/daily/{self.map_symbol(symbol)}/prices"
        data = self._get_json(
            url,
            {
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "token": self.api_key,
                "columns": "date,adjClose",
            },
        )
        return _series([(d["date"][:10], d["adjClose"]) for d in data])


class FMP(Provider):
    """Financial Modeling Prep, stable API (dividend-adjusted EOD prices).

    Newer FMP accounts only have access to /stable/ endpoints; the legacy
    /api/v3/ paths return 403 for them.
    """

    name = "fmp"
    min_interval = 0.25
    workers = 6

    def fetch(self, symbol, start, end):
        data = self._get_json(
            "https://financialmodelingprep.com/stable/historical-price-eod/dividend-adjusted",
            {
                "symbol": self.map_symbol(symbol),
                "from": start.isoformat(),
                "to": end.isoformat(),
                "apikey": self.api_key,
            },
        )
        if not isinstance(data, list):
            return pd.Series(dtype=float)
        return _series([(d["date"], d.get("adjClose")) for d in data if d.get("adjClose")])


class Polygon(Provider):
    name = "polygon"
    min_interval = 0.05

    def map_symbol(self, symbol):
        return symbol  # polygon uses BRK.B

    def fetch(self, symbol, start, end):
        url = (
            f"https://api.polygon.io/v2/aggs/ticker/{self.map_symbol(symbol)}"
            f"/range/1/day/{start.isoformat()}/{end.isoformat()}"
        )
        data = self._get_json(
            url, {"adjusted": "true", "sort": "asc", "limit": 50000, "apiKey": self.api_key}
        )
        results = data.get("results") or []
        return _series(
            [
                (time.strftime("%Y-%m-%d", time.gmtime(r["t"] / 1000)), r["c"])
                for r in results
            ]
        )


class EODHD(Provider):
    name = "eodhd"

    def map_symbol(self, symbol):
        return symbol.replace(".", "-") + ".US"

    def fetch(self, symbol, start, end):
        url = f"https://eodhd.com/api/eod/{self.map_symbol(symbol)}"
        data = self._get_json(
            url,
            {
                "from": start.isoformat(),
                "to": end.isoformat(),
                "api_token": self.api_key,
                "fmt": "json",
            },
        )
        return _series(
            [(d["date"], d.get("adjusted_close", d.get("close"))) for d in data]
        )


class TwelveData(Provider):
    name = "twelvedata"
    min_interval = 0.5

    def fetch(self, symbol, start, end):
        data = self._get_json(
            "https://api.twelvedata.com/time_series",
            {
                "symbol": self.map_symbol(symbol),
                "interval": "1day",
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "adjust": "all",
                "outputsize": 5000,
                "apikey": self.api_key,
            },
        )
        if not isinstance(data, dict) or data.get("status") == "error":
            return pd.Series(dtype=float)
        values = data.get("values") or []
        return _series([(v["datetime"][:10], float(v["close"])) for v in values])


class Finnhub(Provider):
    name = "finnhub"

    def fetch(self, symbol, start, end):
        data = self._get_json(
            "https://finnhub.io/api/v1/stock/candle",
            {
                "symbol": self.map_symbol(symbol),
                "resolution": "D",
                "from": int(time.mktime(start.timetuple())),
                "to": int(time.mktime(end.timetuple())),
                "token": self.api_key,
            },
        )
        if data.get("s") != "ok":
            return pd.Series(dtype=float)
        return _series(
            [
                (time.strftime("%Y-%m-%d", time.gmtime(t)), c)
                for t, c in zip(data["t"], data["c"])
            ]
        )


class AlphaVantage(Provider):
    """Alpha Vantage TIME_SERIES_DAILY_ADJUSTED.

    Note: daily adjusted data is a premium endpoint. A free key answers quote
    endpoints but not this one, in which case detection fails cleanly and the
    pipeline falls back to keyless sources. Premium keys work at ~75+ req/min.
    """

    name = "alphavantage"
    min_interval = 0.9
    workers = 2

    def fetch(self, symbol, start, end):
        data = self._get_json(
            "https://www.alphavantage.co/query",
            {
                "function": "TIME_SERIES_DAILY_ADJUSTED",
                "symbol": self.map_symbol(symbol),
                "outputsize": "full",
                "apikey": self.api_key,
            },
        )
        ts = data.get("Time Series (Daily)") if isinstance(data, dict) else None
        if not ts:
            info = " ".join(
                str(data.get(k, "")) for k in ("Note", "Information", "Error Message")
            ).lower()
            if "premium" in info:
                log.debug("alphavantage: daily-adjusted is premium for this key")
            if "per second" in info or "call frequency" in info or "rate limit" in info:
                raise RateLimited()
            return pd.Series(dtype=float)
        lo, hi = start.isoformat(), end.isoformat()
        return _series(
            [
                (d, float(v["5. adjusted close"]))
                for d, v in ts.items()
                if lo <= d <= hi
            ]
        )


class Yahoo(Provider):
    """Keyless fallback using the public v8 chart endpoint (adjusted close)."""

    name = "yahoo"
    needs_key = False
    min_interval = 0.25
    workers = 6

    def fetch(self, symbol, start, end):
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{self.map_symbol(symbol)}"
        p1 = int(time.mktime(start.timetuple()))
        p2 = int(time.mktime((end + timedelta(days=1)).timetuple()))
        data = self._get_json(
            url,
            {"period1": p1, "period2": p2, "interval": "1d", "events": "div,split"},
        )
        result = (data.get("chart") or {}).get("result") or []
        if not result:
            return pd.Series(dtype=float)
        r = result[0]
        stamps = r.get("timestamp") or []
        ind = r.get("indicators") or {}
        adj = (ind.get("adjclose") or [{}])[0].get("adjclose")
        if not adj:
            adj = (ind.get("quote") or [{}])[0].get("close")
        if not stamps or not adj:
            return pd.Series(dtype=float)
        rows = [
            (time.strftime("%Y-%m-%d", time.gmtime(t)), c)
            for t, c in zip(stamps, adj)
            if c is not None
        ]
        return _series(rows)


class Stooq(Provider):
    """Last-resort keyless fallback; Stooq serves adjusted daily CSVs."""

    name = "stooq"
    needs_key = False
    min_interval = 0.6
    workers = 2

    def map_symbol(self, symbol):
        return symbol.replace(".", "-").lower() + ".us"

    def fetch(self, symbol, start, end):
        self.limiter.wait()
        resp = self.session.get(
            "https://stooq.com/q/d/l/",
            params={
                "s": self.map_symbol(symbol),
                "d1": start.strftime("%Y%m%d"),
                "d2": end.strftime("%Y%m%d"),
                "i": "d",
            },
            timeout=45,
        )
        if resp.status_code == 429:
            raise RateLimited()
        resp.raise_for_status()
        lines = resp.text.strip().splitlines()
        if len(lines) < 2 or not lines[0].lower().startswith("date"):
            return pd.Series(dtype=float)
        rows = []
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) >= 5:
                try:
                    rows.append((parts[0], float(parts[4])))
                except ValueError:
                    continue
        return _series(rows)


KEYED_PROVIDERS = [FMP, Tiingo, Polygon, EODHD, TwelveData, AlphaVantage, Finnhub]


def fetch_market_caps(symbols: list[str]) -> dict[str, float]:
    """Best-effort market caps via FMP's batch quote endpoint (100 per call).

    Returns {} when no FMP-compatible key is available or the calls fail; the
    pipeline treats missing caps as display-only nulls.
    """
    api_key = os.environ.get("API_KEY", "")
    if not api_key:
        return {}
    fmp = FMP(api_key)
    out: dict[str, float] = {}
    mapped = {fmp.map_symbol(sym): sym for sym in symbols}
    keys = list(mapped)
    for i in range(0, len(keys), 100):
        chunk = keys[i : i + 100]
        try:
            data = fmp._get_json(
                "https://financialmodelingprep.com/stable/batch-quote",
                {"symbols": ",".join(chunk), "apikey": api_key},
            )
        except Exception:  # noqa: BLE001 - market cap is optional
            continue
        if not isinstance(data, list):
            continue
        for d in data:
            sym = mapped.get(d.get("symbol"))
            cap = d.get("marketCap")
            if sym and isinstance(cap, (int, float)) and cap > 0:
                out[sym] = float(cap)
    log.info("market caps fetched for %d/%d symbols", len(out), len(symbols))
    return out
FALLBACK_PROVIDERS = [Yahoo, Stooq]

FALLBACK_PROVIDERS = [Yahoo, Stooq]


def _provider_cache_path() -> Path:
    return CACHE_DIR / "provider.json"


def detect_keyed_provider(api_key: str, start: date, end: date) -> Provider | None:
    """Find which supported provider the API key belongs to.

    An explicit ``PRICE_PROVIDER`` env var (e.g. "tiingo") skips detection.
    The detected name is cached on disk so detection runs once per environment.
    """
    by_name = {cls.name: cls for cls in KEYED_PROVIDERS}

    forced = os.environ.get("PRICE_PROVIDER", "").strip().lower()
    if forced:
        if forced in by_name:
            log.info("using provider from PRICE_PROVIDER: %s", forced)
            return by_name[forced](api_key)
        if forced in ("yahoo", "stooq", "none"):
            return None
        log.warning("unknown PRICE_PROVIDER=%s, falling back to detection", forced)

    cache = _provider_cache_path()
    if cache.exists():
        try:
            name = json.loads(cache.read_text()).get("provider")
        except (ValueError, OSError):
            name = None
        if name in by_name:
            log.info("using cached provider: %s", name)
            return by_name[name](api_key)
        # a stale "none" (or unknown) entry is ignored so detection re-runs

    if not api_key:
        return None

    for cls in KEYED_PROVIDERS:
        provider = cls(api_key)
        try:
            s = provider.fetch(DETECTION_SYMBOL, start, end)
        except Exception as exc:  # noqa: BLE001 - any failure means "not this one"
            log.debug("detection: %s failed (%s)", cls.name, type(exc).__name__)
            continue
        if len(s) >= MIN_ROWS_VALID:
            log.info("detected keyed provider: %s", cls.name)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({"provider": cls.name}))
            return provider

    # Deliberately not cached: a transient failure (network blip, 429s) must
    # not permanently disable the keyed provider — re-detect next run.
    log.warning("API key did not match any supported provider; using keyless fallbacks")
    return None


def _fetch_one(chain: list[Provider], symbol: str, start: date, end: date):
    """Try providers in order for one symbol. Returns (series, provider_name)."""
    for provider in chain:
        for attempt in range(3):
            try:
                s = provider.fetch(symbol, start, end)
                if len(s) >= MIN_ROWS_VALID:
                    return s, provider.name
                break  # empty/short result: not a transient error, try next provider
            except RateLimited:
                time.sleep(2.0 * (attempt + 1))
            except requests.RequestException:
                time.sleep(0.5 * (attempt + 1))
            except (KeyError, ValueError, TypeError):
                break
    return pd.Series(dtype=float), None


def _cache_file(symbol: str, end: date) -> Path:
    return CACHE_DIR / f"prices_{end.isoformat()}" / f"{symbol.replace('.', '_')}.json"


def fetch_history(
    symbols: list[str], start: date, end: date, use_cache: bool = True
) -> tuple[dict[str, pd.Series], dict[str, str], list[str]]:
    """Fetch adjusted close history for all symbols.

    Returns (series_by_symbol, provider_by_symbol, failed_symbols).
    """
    api_key = os.environ.get("API_KEY", "")
    keyed = detect_keyed_provider(api_key, start, end)
    chain: list[Provider] = ([keyed] if keyed else []) + [cls() for cls in FALLBACK_PROVIDERS]
    log.info("provider chain: %s", " -> ".join(p.name for p in chain))

    series: dict[str, pd.Series] = {}
    provider_used: dict[str, str] = {}
    failed: list[str] = []
    to_fetch = []

    for sym in symbols:
        cf = _cache_file(sym, end)
        if use_cache and cf.exists():
            try:
                payload = json.loads(cf.read_text())
                s = _series(list(payload["prices"].items()))
                if len(s) >= MIN_ROWS_VALID:
                    series[sym] = s
                    provider_used[sym] = payload.get("provider", "cache")
                    continue
            except (ValueError, OSError, KeyError):
                pass
        to_fetch.append(sym)

    log.info("%d symbols cached, %d to fetch", len(series), len(to_fetch))

    workers = chain[0].workers if chain else 6
    lock = threading.Lock()
    done = 0

    def task(sym: str):
        return sym, _fetch_one(chain, sym, start, end)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(task, s) for s in to_fetch]
        for fut in as_completed(futures):
            sym, (s, pname) = fut.result()
            with lock:
                done += 1
                if done % 100 == 0:
                    log.info("fetched %d/%d", done, len(to_fetch))
            if pname is None:
                failed.append(sym)
                continue
            series[sym] = s
            provider_used[sym] = pname
            if use_cache:
                cf = _cache_file(sym, end)
                cf.parent.mkdir(parents=True, exist_ok=True)
                cf.write_text(
                    json.dumps(
                        {
                            "provider": pname,
                            "prices": {
                                d.strftime("%Y-%m-%d"): float(v) for d, v in s.items()
                            },
                        }
                    )
                )

    if failed:
        log.warning("failed to fetch %d symbols: %s", len(failed), ", ".join(sorted(failed)))
    return series, provider_used, failed
