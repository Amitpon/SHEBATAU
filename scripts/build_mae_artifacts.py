"""Build demo-facing MAE artifacts from the final MAE prediction outputs.

Creates the missing files listed in MissingMAE.md:
  - models/MAE/mae_pipeline_results_enriched.csv
  - models/MAE/mae_pipeline_results_enriched_threshold_085.csv
  - models/MAE/mae_pipeline_results_thresholds.csv
  - models/MAE/calibration_by_lab.csv
  - models/MAE/mae_predictions.csv
  - models/MAE/mae_lab_distributions.json
  - models/MAE/global_lab_correlation.csv
  - models/MAE/pkl/mae_sigmas.pkl and mae_calibrators.pkl
  - calibration/mae/*.png
  - models/MAE/png/*.png

The script reads only saved MAE model outputs, not raw clinical tables.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score


ROOT = Path(__file__).resolve().parents[1]          # Modeling/demo
PROJECT = ROOT.parents[1]                           # project
SRC_MODELS = PROJECT / "Modeling" / "MAE" / "models"
DEST_MODELS = ROOT / "models" / "MAE"
DEST_PKL = DEST_MODELS / "pkl"
DEST_CALIB = ROOT / "calibration" / "mae"
DEST_PNG = DEST_MODELS / "png"

DEFAULT_THRESHOLDS = (0.50, 0.625, 0.75, 0.85, 0.875, 0.99)


def _tag(threshold: float) -> str:
    return f"{int(round(threshold * 100)):03d}"


def _as_bool(s: pd.Series) -> pd.Series:
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin({"true", "1", "yes"})


def _smape(actual: np.ndarray, pred: np.ndarray) -> np.ndarray:
    denom = np.abs(actual) + np.abs(pred)
    out = np.zeros_like(actual, dtype=float)
    mask = denom > 1e-12
    out[mask] = 200.0 * np.abs(pred[mask] - actual[mask]) / denom[mask]
    return out


def _calibration_table(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> tuple[pd.DataFrame, float, float]:
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    rows = []
    n = len(y)
    ece = 0.0
    mce = 0.0
    for left, right in zip(bins[:-1], bins[1:]):
        if right == 1.0:
            mask = (p >= left) & (p <= right)
        else:
            mask = (p >= left) & (p < right)
        if not mask.any():
            continue
        mean_pred = float(p[mask].mean())
        observed = float(y[mask].mean())
        gap = abs(observed - mean_pred)
        ece += (mask.sum() / n) * gap if n else 0.0
        mce = max(mce, gap)
        rows.append(
            {
                "bin_left": left,
                "bin_right": right,
                "mean_pred": mean_pred,
                "observed_stable": observed,
                "n": int(mask.sum()),
                "abs_error": gap,
            }
        )
    return pd.DataFrame(rows), float(ece), float(mce)


def _safe_auc(y: np.ndarray, p: np.ndarray) -> float:
    try:
        if len(np.unique(y)) < 2:
            return np.nan
        return float(roc_auc_score(y, p))
    except ValueError:
        return np.nan


def _lab_metrics(g: pd.DataFrame, threshold: float) -> dict:
    actual = g["actual"].astype(float).to_numpy()
    pred = g["mu"].astype(float).to_numpy()
    p = g["p_stable"].astype(float).clip(0, 1).to_numpy()
    y = _as_bool(g["actual_stable"]).astype(float).to_numpy()
    cancel = p >= threshold
    unstable = y == 0
    fn_mask = cancel & unstable

    total = int(len(g))
    saved = int(cancel.sum())
    fn = int(fn_mask.sum())
    unstable_n = int(unstable.sum())
    stable_rate = float(y.mean()) if total else np.nan
    instability = 1.0 - stable_rate if total else np.nan

    err = pred - actual
    abs_err = np.abs(err)
    rmse = float(np.sqrt(np.mean(err**2))) if total else np.nan
    mean_val = float(np.mean(actual)) if total else np.nan
    smape_vals = _smape(actual, pred)

    brier_model = float(np.mean((p - y) ** 2)) if total else np.nan
    brier_baseline = float(np.mean((stable_rate - y) ** 2)) if total else np.nan
    bss = float((1.0 - brier_model / brier_baseline) * 100.0) if brier_baseline and brier_baseline > 0 else np.nan
    _, ece, mce = _calibration_table(y, p, n_bins=10)
    auc = _safe_auc(y, p)

    return {
        "Total": total,
        "Repeats": total,
        "Repeat%": 100.0,
        "Saved": saved,
        "Saved%": round(100.0 * saved / total, 2) if total else np.nan,
        "FN": fn,
        "FNR%": round(100.0 * fn / unstable_n, 2) if unstable_n else 0.0,
        "FN_per_total%": round(100.0 * fn / total, 2) if total else np.nan,
        "FN_among_cancelled%": round(100.0 * fn / saved, 2) if saved else 0.0,
        "ECE": round(ece, 4),
        "MCE": round(mce, 4),
        "ROC_AUC": round(auc, 4) if np.isfinite(auc) else np.nan,
        "BSS_%": round(bss, 1) if np.isfinite(bss) else np.nan,
        "Base_Stability_%": round(100.0 * stable_rate, 1) if np.isfinite(stable_rate) else np.nan,
        "Instability_%": round(100.0 * instability, 1) if np.isfinite(instability) else np.nan,
        "Brier_Baseline": round(brier_baseline, 4) if np.isfinite(brier_baseline) else np.nan,
        "Brier_Model": round(brier_model, 4) if np.isfinite(brier_model) else np.nan,
        "MAE": round(float(abs_err.mean()), 4) if total else np.nan,
        "mean_val": round(mean_val, 5) if np.isfinite(mean_val) else np.nan,
        "RMSE": round(rmse, 4) if np.isfinite(rmse) else np.nan,
        "SMAPE_med%": round(float(np.median(smape_vals)), 1) if total else np.nan,
        "SMAPE_mean%": round(float(np.mean(smape_vals)), 1) if total else np.nan,
        "NRMSE%": round(100.0 * rmse / abs(mean_val), 1) if np.isfinite(rmse) and abs(mean_val) > 1e-12 else np.nan,
    }


def _copy_core_artifacts() -> None:
    DEST_MODELS.mkdir(parents=True, exist_ok=True)
    DEST_PKL.mkdir(parents=True, exist_ok=True)
    for name in (
        "mae_model.pt",
        "mae_registry.json",
        "mae_config.json",
        "mae_feature_registry.csv",
        "mae_global_confusion.csv",
        "mae_global_confusion_by_threshold.csv",
        "mae_threshold_sweep.csv",
        "mae_training_history.csv",
        "mae_training_loss.png",
    ):
        src = SRC_MODELS / name
        if src.exists():
            shutil.copy2(src, DEST_MODELS / name)
    for name in ("mae_sigmas.pkl", "mae_calibrators.pkl"):
        src = SRC_MODELS / name
        if src.exists():
            shutil.copy2(src, DEST_MODELS / name)
            shutil.copy2(src, DEST_PKL / name)


def _load_predictions(base_threshold: float) -> pd.DataFrame:
    src = SRC_MODELS / f"mae_predictions_threshold_{_tag(base_threshold)}.csv"
    if not src.exists():
        raise FileNotFoundError(f"Missing source prediction file: {src}")
    df = pd.read_csv(src)
    df["actual_stable"] = _as_bool(df["actual_stable"])
    df["p_stable"] = pd.to_numeric(df["p_stable"], errors="coerce").clip(0, 1)
    df["mu"] = pd.to_numeric(df["mu"], errors="coerce")
    df["actual"] = pd.to_numeric(df["actual"], errors="coerce")
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["Lab", "p_stable", "mu", "actual", "actual_stable"])
    DEST_MODELS.mkdir(parents=True, exist_ok=True)
    df.to_csv(DEST_MODELS / "mae_predictions.csv", index=False)
    return df


def _write_metrics(df: pd.DataFrame, thresholds: tuple[float, ...], focus_threshold: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    enriched_rows = []
    threshold_rows = []
    calibration_rows = []

    for lab, g in df.groupby("Lab", sort=True):
        for threshold in thresholds:
            metrics = _lab_metrics(g, threshold)
            threshold_rows.append(
                {
                    "Lab": lab,
                    "Sex": "--",
                    "Threshold": threshold,
                    "Saved": metrics["Saved"],
                    "FN": metrics["FN"],
                    "Saved%": metrics["Saved%"],
                    "FNR%": metrics["FNR%"],
                    "ECE_wf": metrics["ECE"],
                    "MCE_wf": metrics["MCE"],
                    "AUC_wf": metrics["ROC_AUC"],
                    "BSS%_wf": metrics["BSS_%"],
                    "Brier_wf": metrics["Brier_Model"],
                    "Instability_%": metrics["Instability_%"],
                }
            )
        focus = _lab_metrics(g, focus_threshold)
        enriched_rows.append({"Lab": lab, "Threshold": focus_threshold, **focus})
        calibration_rows.append({"Lab": lab, "n": focus["Total"], "ECE": focus["ECE"], "MCE": focus["MCE"]})

    enriched = pd.DataFrame(enriched_rows)
    thresholds_df = pd.DataFrame(threshold_rows)
    calibration = pd.DataFrame(calibration_rows).sort_values(["ECE", "MCE"], ascending=[False, False])

    enriched.to_csv(DEST_MODELS / "mae_pipeline_results_enriched.csv", index=False)
    enriched.to_csv(DEST_MODELS / f"mae_pipeline_results_enriched_threshold_{_tag(focus_threshold)}.csv", index=False)
    thresholds_df.to_csv(DEST_MODELS / "mae_pipeline_results_thresholds.csv", index=False)
    calibration.to_csv(DEST_MODELS / "calibration_by_lab.csv", index=False)
    return enriched, thresholds_df


def _plot_calibration_pngs(df: pd.DataFrame) -> None:
    DEST_CALIB.mkdir(parents=True, exist_ok=True)
    for lab, g in df.groupby("Lab", sort=True):
        p = g["p_stable"].astype(float).clip(0, 1).to_numpy()
        y = _as_bool(g["actual_stable"]).astype(float).to_numpy()
        tab, ece, mce = _calibration_table(y, p, n_bins=10)
        fig, ax = plt.subplots(figsize=(5.2, 4.3))
        ax.plot([0, 1], [0, 1], "--", color="black", linewidth=1.0, label="Perfect calibration")
        if not tab.empty:
            ax.plot(tab["mean_pred"], tab["observed_stable"], marker="o", linewidth=2.0, color="#f39c12", label="MAE")
        ax.set_title(f"{lab} calibration\nn={len(g):,}, ECE={ece:.3f}, MCE={mce:.3f}", fontweight="bold")
        ax.set_xlabel("Predicted P(stable)")
        ax.set_ylabel("Actual fraction stable")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.grid(True, alpha=0.28)
        ax.legend(loc="best", fontsize=8)
        fig.tight_layout()
        fig.savefig(DEST_CALIB / f"{lab}_all.png", dpi=150)
        plt.close(fig)


def _write_distributions_and_correlation() -> None:
    src = SRC_MODELS / "mae_validation_predictions.csv"
    if not src.exists():
        return
    df = pd.read_csv(src)
    df["actual"] = pd.to_numeric(df["actual"], errors="coerce")
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["Lab", "actual"])

    dists = {}
    for lab, g in df.groupby("Lab", sort=True):
        vals = g["actual"].astype(float).to_numpy()
        hist_counts, hist_edges = np.histogram(vals, bins=30)
        dists[lab] = {
            "n": int(len(vals)),
            "mean": round(float(np.mean(vals)), 5),
            "p5": round(float(np.percentile(vals, 5)), 5),
            "p25": round(float(np.percentile(vals, 25)), 5),
            "p50": round(float(np.percentile(vals, 50)), 5),
            "p75": round(float(np.percentile(vals, 75)), 5),
            "p95": round(float(np.percentile(vals, 95)), 5),
            "hist_counts": hist_counts.astype(int).tolist(),
            "hist_edges": [round(float(x), 5) for x in hist_edges.tolist()],
        }
    (DEST_MODELS / "mae_lab_distributions.json").write_text(json.dumps(dists, indent=2), encoding="utf-8")

    pivot = df.pivot_table(index=["id", "admission_key", "date"], columns="Lab", values="actual", aggfunc="mean")
    corr = pivot.corr(min_periods=20)
    corr.to_csv(DEST_MODELS / "global_lab_correlation.csv", encoding="utf-8-sig")


def _summary_pngs(enriched: pd.DataFrame, thresholds_df: pd.DataFrame) -> None:
    DEST_PNG.mkdir(parents=True, exist_ok=True)
    data = enriched.copy()
    data = data.replace([np.inf, -np.inf], np.nan)

    def save(fig, name: str) -> None:
        fig.tight_layout()
        fig.savefig(DEST_PNG / name, dpi=160)
        plt.close(fig)

    top_ece = data.sort_values("ECE", ascending=False).head(25).sort_values("ECE")
    fig, ax = plt.subplots(figsize=(8.5, 6.0))
    ax.barh(top_ece["Lab"], top_ece["ECE"], color="#4c84a6")
    ax.set_title("MAE ECE By Lab", fontweight="bold")
    ax.set_xlabel("ECE (lower = better)")
    save(fig, "summary_ece.png")

    top_auc = data.dropna(subset=["ROC_AUC"]).sort_values("ROC_AUC", ascending=True).tail(30)
    fig, ax = plt.subplots(figsize=(8.5, 6.0))
    ax.barh(top_auc["Lab"], top_auc["ROC_AUC"], color="#1a9850")
    ax.set_title("MAE ROC AUC By Lab", fontweight="bold")
    ax.set_xlabel("ROC AUC")
    ax.set_xlim(0, 1)
    save(fig, "summary_roc_auc.png")

    fig, ax = plt.subplots(figsize=(6.5, 5.2))
    ax.scatter(data["Saved%"], data["FNR%"], s=np.clip(data["Total"] / 45, 25, 180), alpha=0.72, color="#4c84a6", edgecolor="white")
    ax.set_title("MAE Efficiency vs Safety\nthreshold = 0.85", fontweight="bold")
    ax.set_xlabel("Tests Saved -- Saved% (higher = better)")
    ax.set_ylabel("False Negative Rate -- FNR% (lower = safer)")
    ax.grid(True, alpha=0.28)
    ax.set_xlim(left=0)
    ax.set_ylim(bottom=0)
    save(fig, "summary_efficiency_safety.png")

    global_sweep = thresholds_df.groupby("Threshold", as_index=False).agg(Saved=("Saved", "sum"), FN=("FN", "sum"))
    totals = thresholds_df.groupby("Threshold")["Saved"].count()
    global_total = int(data["Total"].sum())
    unstable_by_lab = data["Total"] * data["Instability_%"] / 100.0
    global_unstable = float(unstable_by_lab.sum())
    global_sweep["Saved%"] = 100.0 * global_sweep["Saved"] / global_total if global_total else np.nan
    global_sweep["FNR%"] = 100.0 * global_sweep["FN"] / global_unstable if global_unstable else np.nan
    fig, ax = plt.subplots(figsize=(7.0, 5.0))
    ax.plot(global_sweep["Saved%"], global_sweep["FNR%"], color="#b7b7b7", linewidth=1.8)
    ax.scatter(global_sweep["Saved%"], global_sweep["FNR%"], color="#f39c12", edgecolor="white", s=85, zorder=2)
    for _, row in global_sweep.iterrows():
        ax.annotate(f"{row['Threshold']:.3g}", (row["Saved%"], row["FNR%"]), textcoords="offset points", xytext=(6, 5), fontsize=8)
    ax.set_title("MAE Threshold Sweep\nideal = lower-right", fontweight="bold")
    ax.set_xlabel("Tests Saved -- Saved%")
    ax.set_ylabel("False Negative Rate -- FNR%")
    ax.grid(True, alpha=0.28)
    ax.set_xlim(left=0)
    ax.set_ylim(bottom=0)
    save(fig, "summary_threshold_sweep.png")

    fig, ax = plt.subplots(figsize=(7.0, 5.0))
    ax.scatter(data["Instability_%"], data["Saved%"], color="#4c84a6", alpha=0.75, label="Saved%")
    ax.scatter(data["Instability_%"], data["FNR%"], color="#d73027", alpha=0.75, label="FNR%")
    ax.set_title("MAE Instability vs Decision Metrics", fontweight="bold")
    ax.set_xlabel("Instability%")
    ax.set_ylabel("%")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.28)
    save(fig, "summary_instability_vs_metrics.png")

    fig, ax = plt.subplots(figsize=(7.0, 5.0))
    ax.scatter(data["SMAPE_mean%"], data["NRMSE%"], s=np.clip(data["Total"] / 45, 25, 180), color="#1f9a8a", alpha=0.7, edgecolor="white")
    ax.set_title("MAE Value Error: SMAPE vs NRMSE", fontweight="bold")
    ax.set_xlabel("SMAPE mean%")
    ax.set_ylabel("NRMSE%")
    ax.grid(True, alpha=0.28)
    save(fig, "summary_smape_nrmse.png")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build missing MAE demo artifacts.")
    parser.add_argument("--base-threshold", type=float, default=0.85)
    parser.add_argument("--thresholds", type=float, nargs="*", default=list(DEFAULT_THRESHOLDS))
    args = parser.parse_args()

    thresholds = tuple(float(x) for x in args.thresholds)
    _copy_core_artifacts()
    pred = _load_predictions(args.base_threshold)
    enriched, thresholds_df = _write_metrics(pred, thresholds, args.base_threshold)
    _plot_calibration_pngs(pred)
    _write_distributions_and_correlation()
    _summary_pngs(enriched, thresholds_df)
    print(f"MAE demo artifacts written under {DEST_MODELS}")
    print(f"Calibration plots written under {DEST_CALIB}")


if __name__ == "__main__":
    main()
