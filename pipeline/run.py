"""Pipeline orchestrator.

Usage: python -m pipeline.run [--no-cache] [--output docs/data/rankings.json]

Steps: fetch constituents -> fetch adjusted price history -> compute metrics,
scores and ranks -> validate -> write the JSON consumed by the static site.
Exits non-zero if validation fails.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import constituents as cons
from . import metrics, prices, validate

log = logging.getLogger("pipeline")

# ~13.5 months of calendar history comfortably covers 253 trading days.
HISTORY_DAYS = 420

TABLE_COLUMNS = [
    "symbol",
    "name",
    "sector",
    "index",
    "last_price",
    "price_1m_ago",
    "date_1m_ago",
    "price_6m_ago",
    "date_6m_ago",
    "price_12m_ago",
    "date_12m_ago",
    "return_12_1",
    "return_6_1",
    "volatility_12m",
    "volatility_6m",
    "score_12",
    "score_6",
    "final_score",
    "alternative_score",
    "rank_index",
    "rank_sector",
    "rank_1500",
    "percentile_1500",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-cache", action="store_true", help="ignore the local price cache")
    parser.add_argument("--output", default="docs/data/rankings.json")
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

    errors = validate.validate(table, members)
    if errors:
        for e in errors:
            log.error("VALIDATION: %s", e)
        return 1

    provider_counts: dict[str, int] = {}
    for p in provider_used.values():
        provider_counts[p] = provider_counts.get(p, 0) + 1

    as_of = table["last_date"].value_counts().idxmax()
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": as_of,
        "constituent_counts": counts,
        "ranked_counts": table["index"].value_counts().to_dict(),
        "data_sources": provider_counts,
        "excluded": sorted(excluded, key=lambda x: (x["index"], x["symbol"])),
        "columns": TABLE_COLUMNS,
        "rows": table[TABLE_COLUMNS].where(table[TABLE_COLUMNS].notna(), None).values.tolist(),
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, separators=(",", ":"))
    out.write_text(blob)

    # Daily snapshot archive: one file per as-of date plus a date index, so the
    # site can later show how rankings evolved. Re-runs on the same date just
    # overwrite that day's snapshot.
    hist_dir = out.parent / "history"
    hist_dir.mkdir(exist_ok=True)
    (hist_dir / f"{as_of}.json").write_text(blob)
    dates = sorted(p.stem for p in hist_dir.glob("*.json") if p.stem != "index")
    (hist_dir / "index.json").write_text(json.dumps({"dates": dates}))
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
