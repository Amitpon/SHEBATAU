"""Derive aggregate, non-identifying lab statistics from the raw export.

Writes two self-contained JSON files the backend serves:
  * data/lab_universe.json     - every lab column, split into modeled / unmodeled
  * data/lab_distributions.json - per modeled lab: n, mean, p5/p50/p95 and a 30-bin
                                  histogram (counts + edges) for the Performance view

Only AGGREGATES are stored (counts, percentiles, mean). No patient id, date, MRN or
free-text ever leaves the CSV. Run:  python scripts/build_lab_stats.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.registry import get_registry  # noqa: E402

DATA_DIR = ROOT / "data"
CSV = next((DATA_DIR / "patients" / n for n in ("patients.csv", "data.csv")
            if (DATA_DIR / "patients" / n).exists()), None)
N_BINS = 30


def main() -> None:
    if CSV is None:
        raise SystemExit("No raw export (patients.csv / data.csv) found.")
    reg = get_registry()
    modeled = sorted({e["lab"] for e in reg.entries.values()})

    header = pd.read_csv(CSV, nrows=0).columns.tolist()
    ha = header.index("hospitaladmission")
    universe = header[11:ha]  # contiguous lab block between vitals and admin columns
    unmodeled = [c for c in universe if c not in modeled]

    (DATA_DIR / "lab_universe.json").write_text(
        json.dumps({"modeled": modeled, "unmodeled": unmodeled}, indent=2),
        encoding="utf-8",
    )
    print(f"lab_universe.json: {len(modeled)} modeled, {len(unmodeled)} unmodeled")

    # Distributions only for modeled labs (those shown in Performance).
    present = [l for l in modeled if l in header]
    df = pd.read_csv(CSV, usecols=present, low_memory=False)

    dists: dict[str, dict] = {}
    for lab in present:
        v = pd.to_numeric(df[lab], errors="coerce").dropna().to_numpy()
        if v.size < 5:
            continue
        p1, p5, p50, p95, p99 = np.percentile(v, [1, 5, 50, 95, 99])
        lo, hi = float(p1), float(p99)
        if hi <= lo:
            hi = lo + 1.0
        counts, edges = np.histogram(np.clip(v, lo, hi), bins=N_BINS, range=(lo, hi))
        dists[lab] = {
            "n": int(v.size),
            "mean": round(float(v.mean()), 3),
            "p5": round(float(p5), 3),
            "p50": round(float(p50), 3),
            "p95": round(float(p95), 3),
            "edges": [round(float(e), 3) for e in edges],
            "counts": [int(c) for c in counts],
        }
    (DATA_DIR / "lab_distributions.json").write_text(
        json.dumps(dists, indent=2), encoding="utf-8"
    )
    print(f"lab_distributions.json: {len(dists)} labs")


if __name__ == "__main__":
    main()
