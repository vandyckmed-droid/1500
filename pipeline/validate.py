"""Sanity checks on the computed ranking table.

The pipeline fails (non-zero exit) if coverage or the numbers themselves look
wrong, so a broken data source can never silently publish a bad site.
"""
from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger(__name__)

MIN_COVERAGE = 0.85  # ranked share of each index's constituents


def validate(table: pd.DataFrame, constituents: pd.DataFrame) -> list[str]:
    """Return a list of validation error strings (empty = all good)."""
    errors: list[str] = []
    if table.empty:
        return ["ranking table is empty"]

    for idx_key, group in constituents.groupby("index"):
        total = len(group)
        ranked = int((table["index"] == idx_key).sum())
        cov = ranked / total if total else 0.0
        log.info("coverage %s: %d/%d (%.1f%%)", idx_key, ranked, total, 100 * cov)
        if cov < MIN_COVERAGE:
            errors.append(
                f"{idx_key}: only {ranked}/{total} constituents ranked "
                f"({100 * cov:.1f}% < {100 * MIN_COVERAGE:.0f}%)"
            )

    for col in ("final_score", "score_12", "score_6"):
        if table[col].isna().any():
            errors.append(f"NaN values in {col}")

    if not table["volatility_12m"].between(0.01, 5).all():
        errors.append("volatility_12m outside plausible range (0.01, 5)")
    if not table["volatility_6m"].between(0.01, 5).all():
        errors.append("volatility_6m outside plausible range (0.01, 5)")
    # Extreme single-name returns do happen (e.g. SNDK ~34x in 2025-26), so the
    # hard bound is generous; anything past it is almost certainly bad data.
    if table["return_12_1"].abs().max() > 60:
        errors.append("return_12_1 has values beyond +/-6000%")
    if (table["last_price"] <= 0).any():
        errors.append("non-positive prices present")

    # Ranks must be a permutation starting at 1.
    if int(table["rank_1500"].min()) != 1:
        errors.append("rank_1500 does not start at 1")
    for idx_key in table["index"].unique():
        sub = table[table["index"] == idx_key]
        if int(sub["rank_index"].min()) != 1:
            errors.append(f"rank_index for {idx_key} does not start at 1")

    # Stale data check: the most common last_date should be shared broadly.
    mode_share = table["last_date"].value_counts(normalize=True).iloc[0]
    if mode_share < 0.8:
        errors.append(
            f"price series end dates are inconsistent (top date covers {100 * mode_share:.0f}%)"
        )
    return errors
