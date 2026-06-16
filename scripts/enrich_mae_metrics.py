"""Compute NGBoost-style leaderboard metrics for the final MAE demo artifacts.

Inputs:
  Modeling/MAE/models/mae_predictions_threshold_<threshold>.csv

Output:
  Modeling/demo/models/MAE/mae_pipeline_results_enriched_threshold_<threshold>.csv

This fills MAE leaderboard fields that are not present in the raw MAE sweep file:
ECE, MCE, BSS_%, RMSE, mean_val, SMAPE_mean%, and NRMSE%.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]


def threshold_tag(threshold: float) -> str:
    return f"{int(round(threshold * 100)):03d}"


def calibration_errors(y_true: np.ndarray, p: np.ndarray, n_bins: int = 10) -> tuple[float, float]:
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    mce = 0.0
    n = len(y_true)
    for left, right in zip(bins[:-1], bins[1:]):
        if right == 1.0:
            mask = (p >= left) & (p <= right)
        else:
            mask = (p >= left) & (p < right)
        if not mask.any():
            continue
        conf = float(p[mask].mean())
        obs = float(y_true[mask].mean())
        gap = abs(conf - obs)
        ece += (mask.sum() / n) * gap
        mce = max(mce, gap)
    return ece, mce


def smape(actual: np.ndarray, pred: np.ndarray) -> np.ndarray:
    denom = np.abs(actual) + np.abs(pred)
    out = np.zeros_like(actual, dtype=float)
    mask = denom > 1e-12
    out[mask] = 200.0 * np.abs(pred[mask] - actual[mask]) / denom[mask]
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute NGBoost-style per-lab metrics for MAE predictions.")
    parser.add_argument("--threshold", type=float, default=0.85, help="Decision threshold, for example 0.85.")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional output CSV path. Defaults to demo/models/MAE/mae_pipeline_results_enriched_threshold_<tag>.csv.",
    )
    args = parser.parse_args()

    tag = threshold_tag(args.threshold)
    src = PROJECT / "Modeling" / "MAE" / "models" / f"mae_predictions_threshold_{tag}.csv"
    out_path = args.output or ROOT / "models" / "MAE" / f"mae_pipeline_results_enriched_threshold_{tag}.csv"

    if not src.exists():
        raise FileNotFoundError(f"Missing MAE prediction file: {src}")
    df = pd.read_csv(src)
    rows = []
    for lab, g in df.groupby("Lab", sort=True):
        actual = g["actual"].astype(float).to_numpy()
        pred = g["mu"].astype(float).to_numpy()
        p = g["p_stable"].astype(float).clip(0, 1).to_numpy()
        y = g["actual_stable"].astype(bool).astype(float).to_numpy()
        cancel = g["cancel"].astype(bool).to_numpy()
        unstable = 1.0 - y

        err = pred - actual
        abs_err = np.abs(err)
        rmse = float(np.sqrt(np.mean(err ** 2)))
        mean_val = float(np.mean(actual))
        smape_vals = smape(actual, pred)

        brier_model = float(np.mean((p - y) ** 2))
        base_rate = float(y.mean())
        brier_baseline = float(np.mean((base_rate - y) ** 2))
        bss = float((1.0 - brier_model / brier_baseline) * 100.0) if brier_baseline > 0 else np.nan
        ece, mce = calibration_errors(y, p)
        try:
            roc = float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else np.nan
        except ValueError:
            roc = np.nan

        saved = int(cancel.sum())
        fn = int((cancel & (unstable == 1)).sum())
        total = int(len(g))
        rows.append(
            {
                "Lab": lab,
                "Threshold": args.threshold,
                "Total": total,
                "Repeats": total,
                "Repeat%": 100.0,
                "Saved": saved,
                "Saved%": round(100.0 * saved / total, 2) if total else np.nan,
                "FN": fn,
                "FNR%": round(100.0 * fn / total, 2) if total else np.nan,
                "FN_among_cancelled%": round(100.0 * fn / saved, 2) if saved else 0.0,
                "ECE": round(ece, 4),
                "MCE": round(mce, 4),
                "ROC_AUC": round(roc, 4) if np.isfinite(roc) else np.nan,
                "BSS_%": round(bss, 1) if np.isfinite(bss) else np.nan,
                "Base_Stability_%": round(100.0 * base_rate, 1),
                "Instability_%": round(100.0 * (1.0 - base_rate), 1),
                "Brier_Baseline": round(brier_baseline, 4),
                "Brier_Model": round(brier_model, 4),
                "MAE": round(float(abs_err.mean()), 4),
                "mean_val": round(mean_val, 5),
                "RMSE": round(rmse, 4),
                "SMAPE_med%": round(float(np.median(smape_vals)), 1),
                "SMAPE_mean%": round(float(np.mean(smape_vals)), 1),
                "NRMSE%": round(100.0 * rmse / abs(mean_val), 1) if abs(mean_val) > 1e-12 else np.nan,
            }
        )
    out = pd.DataFrame(rows)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(out_path, index=False)
    print(f"wrote {out_path} ({len(out)} labs)")


if __name__ == "__main__":
    main()
