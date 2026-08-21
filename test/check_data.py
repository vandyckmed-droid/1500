"""Schema and sanity checks on the published data files.

Standalone (stdlib only) so CI can validate what is actually served, not just
what the pipeline intended to write. The pipeline's own validate.py gates the
nightly publish; this gates every pull request.

Checks rankings.json, and — once the nightly pipeline has published it —
returns.json in the same directory: schema, coverage against the ranked
symbols, matching as_of, and a spot reconciliation that recomputing 63-day
volatility from the matrix's quantized log returns lands on the rankings'
volatility_63d. Until the file first appears, its absence is reported and
allowed (dark launch).

Usage: python3 test/check_data.py docs/data/rankings.json
"""
from __future__ import annotations

import json
import math
import os
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

    errors += check_returns(os.path.join(os.path.dirname(path), "returns.json"), d, idx)
    return report(errors)


def check_returns(path: str, rankings: dict, idx: dict) -> list[str]:
    if not os.path.exists(path):
        print("returns.json not yet published (dark launch pending) — skipped")
        return []
    errors: list[str] = []
    with open(path) as f:
        m = json.load(f)
    for k in ("as_of", "dates", "scale", "kind", "returns"):
        if k not in m:
            return [f"returns.json: missing key {k}"]
    if m["as_of"] != rankings["as_of"]:
        errors.append(f"returns.json as_of {m['as_of']} != rankings as_of {rankings['as_of']}")
    ndays = len(m["dates"])
    if ndays < 100:
        errors.append(f"returns.json only {ndays} days deep")
    syms = {r[idx["symbol"]] for r in rankings["rows"]}
    covered = sum(1 for s in m["returns"] if s in syms)
    if covered < 0.9 * len(syms):
        errors.append(f"returns.json covers {covered}/{len(syms)} ranked symbols (< 90%)")
    for arr in m["returns"].values():
        if len(arr) != ndays:
            errors.append("returns.json: row length != dates length")
            break

    # Spot reconciliation: vol recomputed from the matrix's quantized log
    # returns must land on the rankings' volatility_63d.
    scale = m["scale"]
    checked = 0
    for r in rankings["rows"]:
        if checked >= 5:
            break
        sym = r[idx["symbol"]]
        arr = m["returns"].get(sym)
        if not arr:
            continue
        tail = arr[-63:]
        if len(tail) < 63 or any(v is None for v in tail):
            continue
        rets = [math.exp(v / scale) - 1 for v in tail]
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        vol = math.sqrt(var * 252)
        expected = r[idx["volatility_63d"]]
        if abs(vol - expected) > 5e-3:
            errors.append(
                f"returns.json: {sym} vol from matrix {vol:.4f} != rankings {expected:.4f}"
            )
        checked += 1
    if checked < 3:
        errors.append("returns.json: fewer than 3 symbols reconcilable against rankings")
    else:
        print(f"returns.json ok: {covered} symbols x {ndays} days, {checked} vols reconciled")
    return errors


def report(errors: list[str]) -> int:
    if errors:
        for e in errors:
            print(f"DATA CHECK FAILED: {e}", file=sys.stderr)
        return 1
    print("data check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "docs/data/rankings.json"))
