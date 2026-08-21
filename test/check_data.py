"""Schema and sanity checks on the published rankings file.

Standalone (stdlib only) so CI can validate what is actually served, not just
what the pipeline intended to write. The pipeline's own validate.py gates the
nightly publish; this gates every pull request.

Usage: python3 test/check_data.py docs/data/rankings.json
"""
from __future__ import annotations

import json
import re
import sys

REQUIRED_TOP = ["as_of", "generated_at", "columns", "rows", "constituent_counts", "sectors"]
REQUIRED_COLS = [
    "symbol", "name", "index", "sector", "last_price", "last_date",
    "return_12_1", "return_6_1", "volatility_63d",
    "score_12", "score_6", "final_score",
    "rank_1500", "rank_index", "rank_sector",
]
MIN_ROWS = 1300


def main(path: str) -> int:
    errors: list[str] = []
    with open(path) as f:
        d = json.load(f)

    for k in REQUIRED_TOP:
        if k not in d:
            errors.append(f"missing top-level key: {k}")
    if errors:
        return report(errors)

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d["as_of"]):
        errors.append(f"as_of is not YYYY-MM-DD: {d['as_of']!r}")

    cols = d["columns"]
    idx = {c: i for i, c in enumerate(cols)}
    for c in REQUIRED_COLS:
        if c not in idx:
            errors.append(f"missing column: {c}")
    if errors:
        return report(errors)

    rows = d["rows"]
    if len(rows) < MIN_ROWS:
        errors.append(f"only {len(rows)} rows (< {MIN_ROWS})")

    ranks = [r[idx["rank_1500"]] for r in rows]
    if ranks and min(ranks) != 1:
        errors.append("rank_1500 does not start at 1")
    if ranks and max(ranks) > len(rows):
        errors.append("rank_1500 exceeds row count")
    if ranks != sorted(ranks):
        errors.append("rows are not sorted by rank_1500")

    for r in rows:
        v = r[idx["volatility_63d"]]
        if v is None or not (0.01 <= v <= 5):
            errors.append(f"{r[idx['symbol']]}: volatility_63d out of range: {v}")
            break
        if r[idx["final_score"]] is None:
            errors.append(f"{r[idx['symbol']]}: null final_score in ranked rows")
            break
        if r[idx["last_price"]] is None or r[idx["last_price"]] <= 0:
            errors.append(f"{r[idx['symbol']]}: non-positive last_price")
            break

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for e in errors:
            print(f"DATA CHECK FAILED: {e}", file=sys.stderr)
        return 1
    print("data check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "docs/data/rankings.json"))
