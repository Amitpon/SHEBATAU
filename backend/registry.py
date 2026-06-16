"""Loads the trained-artifact metadata and shared helper objects.

The ``registry.json`` produced by the training pipeline is the contract between the
``.pkl`` artifacts and this backend. Everything the API needs to know about a lab —
which features to collect, how to transform the target, the stability threshold, the
panel it belongs to, and how strong the model is — comes from here. We never invent
any of these numbers.
"""
from __future__ import annotations

import csv
import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

import joblib

# project_root/backend/registry.py -> project_root
ROOT = Path(__file__).resolve().parent.parent
NGB_DIR = ROOT / "models" / "ngboost"
PKL_DIR = NGB_DIR / "pkl"
# user-supplied calibration plots, served at /calibration (drop <Lab>.png here)
CALIB_DIR = ROOT / "calibration"
_CALIB_EXT = (".png", ".jpg", ".jpeg", ".webp", ".svg")


def calibration_file(lab: str) -> Optional[str]:
    """Served URL for a lab's calibration plot.

    Searches calibration/ and calibration/ngboost/ for files matching the lab name
    or the registry key (e.g. Creatinine_all.png, HGB_M.png).
    """
    from urllib.parse import quote

    search_dirs = [CALIB_DIR, CALIB_DIR / "ngboost"]
    low = lab.lower()
    for d in search_dirs:
        if not d.exists():
            continue
        for f in sorted(d.iterdir()):
            if not f.is_file() or f.suffix.lower() not in _CALIB_EXT:
                continue
            stem = f.stem.lower()
            if stem == low or stem.startswith(low + "_") or stem.startswith(low):
                rel = f.relative_to(CALIB_DIR)
                return f"/calibration/{quote(str(rel).replace(chr(92), '/'))}"
    return None


def calibration_files_sex(lab: str) -> Optional[dict]:
    """For sex-specific labs: returns {'M': url, 'F': url} when both exist.
    Returns None for non-sex-specific labs or when files are missing.
    """
    from urllib.parse import quote

    search_dirs = [CALIB_DIR, CALIB_DIR / "ngboost"]
    low = lab.lower()
    found: dict = {}
    for sex in ("M", "F"):
        target = f"{low}_{sex.lower()}"
        for d in search_dirs:
            if not d.exists():
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file() or f.suffix.lower() not in _CALIB_EXT:
                    continue
                if f.stem.lower() == target:
                    rel = f.relative_to(CALIB_DIR)
                    found[sex] = f"/calibration/{quote(str(rel).replace(chr(92), '/'))}"
                    break
    return found if len(found) >= 2 else None

# Labs whose models are split by sex; everything else uses the "_all" scope.
# Derived from the registry at load time, this constant is only a fallback hint.
SEX_SCOPED_HINT = {"HGB", "HCT", "RBC", "CPK", "HDL", "Ferritin", "Methemoglobin"}

# Labs we deliberately never modelled (and the reason). These are derived/duplicate/
# qualitative columns - not a data shortage. Any other unmodelled lab is treated as
# "insufficient data". Reasons are user-facing -> hyphens only, no em-dash.
EXCLUDED_LABS = {
    "Volume_ml":            "administrative field",
    "MCVr":                 "derived value (reticulocyte MCV - calculated from MCV)",
    "Anion_gap":            "derived value",
    "eGFR_MDRD":            "derived value",
    "eGFR_CKD_EPI":         "derived value",
    "Non_HDL":              "derived value",
    "Neutro_lympho_ratio":  "derived ratio",
    "Lympho_mono_ratio":    "derived ratio",
    "PLT_lympho_ratio":     "derived ratio",
    "Hemoglobin_POC":       "point-of-care duplicate",
    "Glucose_POC":          "point-of-care duplicate",
    "Hematocrit_POC":       "point-of-care duplicate",
    "Potassium_POC":        "point-of-care duplicate",
    "Sodium_POC":           "point-of-care duplicate",
    "Chloride_POC":         "point-of-care duplicate",
    "HbA1c_mmol":           "unit-conversion duplicate",
    "Ketones":              "qualitative result",
    "Glucose_qualitative":  "qualitative result",
    "Protein_qualitative":  "qualitative result",
    "Bilirubin_urine":      "qualitative result",
    "NRBC_pct":             "raw percent - derived from the absolute count in the same panel run",
    "Baso_pct":             "raw percent - derived from the absolute count in the same panel run",
    "Eos_pct":              "raw percent - derived from the absolute count in the same panel run",
    "Mono_pct":             "raw percent - derived from the absolute count in the same panel run",
    "Lympho_pct":           "raw percent - derived from the absolute count in the same panel run",
    "Neutro_pct":           "raw percent - derived from the absolute count in the same panel run",
    "Reticulo_pct":         "raw percent - derived from the absolute count in the same panel run",
    "MCH":                  "derived value - calculated from HGB and RBC",
    "MCHC":                 "derived value - calculated from HGB and HCT",
    "PCT":                  "derived value - calculated from PLT and MPV",
    "VLDL":                 "derived value - calculated from Triglycerides / 5",
    "HCO3":                 "calculated blood-gas value - derived from pH and pCO2 (Henderson-Hasselbalch)",
    "Base_Excess":          "calculated blood-gas value - derived from pH and pCO2",
}


def _excluded_category(reason: str) -> str:
    """Bucket an EXCLUDED_LABS reason into a tidy theme for the UI."""
    r = reason.lower()
    if "ratio" in r:
        return "Derived ratios"
    if "percent" in r:
        return "Percentages (derived from the absolute count)"
    if "point-of-care" in r:
        return "Point-of-care duplicates"
    if "unit-conversion" in r:
        return "Unit-conversion duplicates"
    if "qualitative" in r:
        return "Qualitative results"
    if "administrative" in r:
        return "Administrative fields"
    if "blood-gas" in r:
        return "Calculated blood-gas values"
    if "derived" in r or "calculated" in r:
        return "Derived / calculated values"
    return "Other"


class Registry:
    """Single in-memory view over registry.json + shared helper artifacts."""

    def __init__(self) -> None:
        reg_path = NGB_DIR / "registry.json"
        if not reg_path.exists():
            reg_path = PKL_DIR / "registry.json"
        with open(reg_path, encoding="utf-8") as fh:
            self.entries: dict[str, dict] = json.load(fh)

        # Shared helper objects (joblib, not bare pickle).
        self.clip_bounds: dict[str, tuple] = joblib.load(PKL_DIR / "clip_bounds.pkl")
        self.quant_steps: dict[str, float] = joblib.load(PKL_DIR / "quant_steps.pkl")
        self.correlation = joblib.load(PKL_DIR / "global_lab_correlation.pkl")

        # Per-(lab, sex) performance metrics for the reliability message.
        self.metrics: dict[tuple[str, str], dict] = self._load_pipeline_results()

        # Threshold-sensitivity data: {lab: [{Threshold, Saved%, FNR%, ...}, ...]}
        self.threshold_data: dict[str, list[dict]] = self._load_threshold_data()

        # Aggregate, non-identifying lab stats derived from the raw export (optional).
        self.lab_dist: dict[str, dict] = self._load_json(ROOT / "data" / "lab_distributions.json")
        self._universe: dict[str, list] = self._load_json(ROOT / "data" / "lab_universe.json")

        # lab name -> {sex_code: registry_key}; sex_code is "all" | "M" | "F".
        self._scopes: dict[str, dict[str, str]] = {}
        for key, ent in self.entries.items():
            lab = ent["lab"]
            sex = ent.get("sex")
            code = sex if sex in ("M", "F") else "all"
            self._scopes.setdefault(lab, {})[code] = key

    def _load_pipeline_results(self) -> dict[tuple[str, str], dict]:
        out: dict[tuple[str, str], dict] = {}
        path = NGB_DIR / "pipeline_results.csv"
        if not path.exists():
            return out
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                sex = (row.get("Sex") or "--").strip()
                sex_code = sex if sex in ("M", "F") else "all"
                out[(row["Lab"], sex_code)] = row
        return out

    @staticmethod
    def _load_json(path: Path) -> dict:
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def lab_universe(self) -> dict:
        """Lab columns split into modeled / excluded-by-design / insufficient-data.

        - modeled: has a trained model (selectable).
        - excluded: deliberately never modelled (derived/duplicate/qualitative) + reason.
        - insufficient: a real lab we simply lack enough data to model -> always repeat.
        """
        if self._universe and self._universe.get("modeled"):
            modeled = self._universe["modeled"]
            unmodeled = self._universe.get("unmodeled", [])
        else:
            modeled = sorted(self._scopes.keys())
            unmodeled = []
        excluded = {l: EXCLUDED_LABS[l] for l in unmodeled if l in EXCLUDED_LABS}
        insufficient = [l for l in unmodeled if l not in EXCLUDED_LABS]
        # group the excluded labs by theme so the UI can show tidy, collapsible buckets
        groups: dict[str, list] = {}
        for lab in sorted(excluded):
            cat = _excluded_category(excluded[lab])
            groups.setdefault(cat, []).append({"lab": lab, "reason": excluded[lab]})
        return {
            "modeled": modeled,
            "excluded": excluded,
            "excluded_groups": groups,
            "insufficient": insufficient,
            "unmodeled": unmodeled,  # kept for backward-compat
        }

    def lab_distribution(self, lab: str) -> dict:
        """Aggregate value distribution (mean, percentiles, histogram) for one lab."""
        return self.lab_dist.get(lab, {})

    def _load_threshold_data(self) -> dict[str, list[dict]]:
        path = NGB_DIR / "pipeline_results_thresholds.csv"
        if not path.exists():
            return {}
        out: dict[str, list[dict]] = {}
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                lab = row.get("Lab", "")
                try:
                    point = {
                        "threshold": float(row["Threshold"]),
                        "saved_pct": float(row.get("Saved%", 0)),
                        "fnr_pct": float(row.get("FNR%", 0)),
                        "ece": float(row.get("ECE_wf", 0)),
                        "brier": float(row.get("Brier_wf", 0)),
                        "bss_pct": float(row.get("BSS%_wf", 0)),
                    }
                except (TypeError, ValueError):
                    continue
                out.setdefault(lab, []).append(point)
        return out

    def threshold_curve(self, lab: str) -> list[dict]:
        """Saved% vs FNR% per decision threshold, ordered 0.5 -> 0.99.

        As the threshold rises we demand more confidence before skipping, so we skip
        fewer tests: saved% should fall monotonically. A point whose saved% is HIGHER
        than a lower-threshold point is a data inversion; we flag it ``anomaly: true``
        so the UI draws the connecting line only through the clean (monotonic) points
        and footnotes the rest with an asterisk.
        """
        points = sorted(self.threshold_data.get(lab, []), key=lambda p: p["threshold"])
        kept_saved = None
        for p in points:
            sv = p["saved_pct"]
            if kept_saved is not None and sv > kept_saved + 1e-9:
                p["anomaly"] = True  # higher threshold "saved" more -> inversion
            else:
                p["anomaly"] = False
                kept_saved = sv
        return points

    def profile_correlations(self, labs: list[str]) -> dict:
        """Intra-set correlation sub-matrix + homogeneity for any ad-hoc lab list.

        Off-diagonal |r| >= 0.999 is a degenerate +/-1 from too-few co-measurements
        (same artifact filtered in top_correlations); such cells are returned as null
        and excluded from the homogeneity average so the score is not inflated.
        """
        import numpy as np
        return self._corr_block([l for l in labs if l in self.correlation.columns],
                                missing=[l for l in labs if l not in self.correlation.columns])

    def _corr_block(self, present: list[str], missing: list[str]) -> dict:
        import numpy as np
        corr = self.correlation
        matrix, abs_vals = [], []
        if present:
            sub = corr.loc[present, present]
            for r_lab in present:
                row = []
                for c_lab in present:
                    v = float(sub.loc[r_lab, c_lab])
                    if r_lab == c_lab:
                        row.append(1.0)
                    elif abs(v) >= 0.999:
                        row.append(None)  # spurious perfect correlation -> hide
                    else:
                        row.append(round(v, 3))
                        abs_vals.append(abs(v))
                matrix.append(row)
        avg = round(float(np.mean(abs_vals)), 3) if abs_vals else None
        return {
            "labs": present,
            "missing": missing,
            "matrix": matrix,
            "avg_abs_r": avg,
            "homogeneity": (
                "high" if avg and avg >= 0.5 else
                "moderate" if avg and avg >= 0.2 else
                "low" if avg else "unknown"
            ),
        }

    def panel_correlations(self, panel: str) -> dict:
        """Sub-matrix of correlations for a panel's labs + homogeneity stats."""
        members = self.panels().get(panel, [])
        if not members:
            return {"panel": panel, "labs": [], "matrix": [], "avg_abs_r": None}
        present = [l for l in members if l in self.correlation.columns]
        block = self._corr_block(present, missing=[l for l in members if l not in present])
        return {"panel": panel, **block}

    # ------------------------------------------------------------------ lookup
    def resolve_key(self, lab: str, sex: Optional[str]) -> str:
        """Map a lab name (+ patient sex) to the concrete registry/model key."""
        scopes = self._scopes.get(lab)
        if not scopes:
            raise KeyError(f"Unknown lab: {lab!r}")
        if "all" in scopes:
            return scopes["all"]
        code = (sex or "").upper()[:1]
        if code in scopes:
            return scopes[code]
        raise KeyError(
            f"Lab {lab!r} is sex-specific ({sorted(scopes)}); patient sex is required."
        )

    def entry(self, lab: str, sex: Optional[str]) -> dict:
        return self.entries[self.resolve_key(lab, sex)]

    def metrics_for(self, lab: str, sex: Optional[str]) -> dict:
        scopes = self._scopes.get(lab, {})
        code = "all" if "all" in scopes else (sex or "").upper()[:1]
        return self.metrics.get((lab, code), {})

    def _weighted_metrics(self, lab: str, scopes: dict) -> dict:
        """Weighted average of numeric metrics across sex scopes (M + F), by n_test.
        Used in performance_table() for sex-specific labs so the leaderboard shows
        one combined row instead of silently picking only M or F.
        """
        def fnum(row, key):
            try:
                return float(row.get(key, ""))
            except (TypeError, ValueError):
                return None

        rows = []
        for code in sorted(scopes):
            m = self.metrics.get((lab, code), {})
            n = fnum(m, "Total")
            if m and n:
                rows.append((n, m))

        if not rows:
            return {}
        if len(rows) == 1:
            return rows[0][1]

        total_n = sum(n for n, _ in rows)
        keys_to_avg = [
            "SMAPE_mean%", "SMAPE_med%", "NRMSE%", "MAE", "RMSE",
            "ECE", "MCE", "BSS_%", "ROC_AUC",
            "Brier_model", "Brier_baseline", "Saved%", "FNR%", "Base_Stability_%",
        ]
        result: dict = {"Total": total_n}
        for key in keys_to_avg:
            vals = [(n, fnum(m, key)) for n, m in rows]
            valid = [(n, v) for n, v in vals if v is not None]
            if valid:
                vn = sum(n for n, _ in valid)
                result[key] = sum(n * v for n, v in valid) / vn
        # Non-numeric fields: copy from first scope
        for k, v in rows[0][1].items():
            if k not in result:
                result[k] = v
        return result

    def sex_breakdown(self, lab: str) -> Optional[list]:
        """For sex-specific labs: per-scope metric dicts for M and F.
        Returns None for labs with an 'all' scope (not sex-specific).
        """
        scopes = self._scopes.get(lab, {})
        if "all" in scopes:
            return None
        result = []
        for code in sorted(scopes):
            m = self.metrics.get((lab, code), {})
            if m:
                result.append({"sex": code, "metrics": m})
        return result if len(result) >= 2 else None

    def ngb_n_test(self, lab: str) -> Optional[float]:
        """Total NGBoost test-set records for a lab, summed across sex scopes.

        None means we have no count (no metrics row) - the caller decides how to treat
        an unknown count (we default to 'available' so a real model is never hidden on
        a lookup miss)."""
        scopes = self._scopes.get(lab)
        if not scopes:
            return None
        total, found = 0.0, False
        for code in scopes:  # 'all' | 'M' | 'F'
            m = self.metrics.get((lab, code), {})
            try:
                total += float(m.get("Total"))
                found = True
            except (TypeError, ValueError):
                pass
        return total if found else None

    def clip_for(self, lab: str) -> Optional[tuple]:
        return self.clip_bounds.get(lab)

    def family(self, lab: str) -> Optional[str]:
        scopes = self._scopes.get(lab, {})
        if not scopes:
            return None
        return self.entries[next(iter(scopes.values()))].get("profile_family")

    def panels(self) -> dict[str, list[str]]:
        """profile_family -> member labs (the known panels: CBC, BG_chem, BG_gas)."""
        out: dict[str, list[str]] = {}
        for lab, scopes in self._scopes.items():
            fam = self.entries[next(iter(scopes.values()))].get("profile_family")
            if fam:
                out.setdefault(fam, []).append(lab)
        return {k: sorted(v) for k, v in sorted(out.items())}

    def lab_norms(self) -> dict[str, dict]:
        """Per-lab typical value + plausible range, straight from the trained data.

        `typical` is the test-set mean (mean_val_te); `low`/`high` are the model's
        physiological clip bounds; `spread` (rmse_te) lets the UI draw a realistic
        random value near the typical. Nothing here is invented.
        """
        out: dict[str, dict] = {}
        for lab, scopes in self._scopes.items():
            ent = self.entries[next(iter(scopes.values()))]
            clip = self.clip_bounds.get(lab)
            typical_raw = ent.get("mean_val_te")
            spread = ent.get("rmse_te")
            q = self.quant_for(lab)  # reporting step for this lab
            # Round typical to the lab's own reporting step so the pre-filled value
            # looks like a real measurement (e.g. AST→23 not 22.51, pH→7.5 not 7.482).
            def _qround(v, qstep):
                if v is None or qstep <= 0:
                    return round(float(v), 3) if v is not None else None
                import math
                rounded = round(float(v) / qstep) * qstep
                decimals = max(0, -int(math.floor(math.log10(qstep)))) if qstep < 1 else 0
                return round(rounded, decimals)
            out[lab] = {
                "typical": _qround(typical_raw, q),
                "quant_step": q if q else None,
                "low": round(float(clip[0]), 3) if clip and clip[0] is not None else None,
                "high": round(float(clip[1]), 3) if clip and clip[1] is not None else None,
                "spread": round(float(spread), 3) if spread is not None else None,
            }
        return out

    def top_correlations(self, lab: str, n: int = 8) -> list[dict]:
        """Labs most correlated (by |r|) with the given lab, from the trained matrix.

        Drops spurious perfect correlations (|r| >= 0.999): ~19% of the matrix is
        degenerate +/-1 from pairs with too few co-measurements, which is clinically
        meaningless. We keep only genuine partial correlations.
        """
        corr = self.correlation
        if lab not in corr.columns:
            return []
        series = corr[lab].drop(labels=[lab], errors="ignore").dropna()
        series = series[series.abs() < 0.999]
        ranked = series.reindex(series.abs().sort_values(ascending=False).index)
        return [{"lab": k, "r": round(float(v), 3)} for k, v in ranked.head(n).items()]

    def performance_table(self) -> list[dict]:
        """Headline metrics for every lab, for the cross-test comparison / leaderboard.

        Focus on calibration (ECE/MCE, Brier model vs baseline) and value accuracy
        (MAE/RMSE/SMAPE/NRMSE). Saved%/ROC are intentionally not the headline.
        """
        from .models.base import reliability_label  # local import avoids a cycle

        def fnum(row, key):
            try:
                return float(row.get(key, ""))
            except (TypeError, ValueError):
                return None

        out = []
        for lab, scopes in sorted(self._scopes.items()):
            m = self.metrics_for(lab, None)
            if not m:
                # Sex-specific labs: compute a weighted average across M + F scopes.
                m = self._weighted_metrics(lab, scopes)
            if not m:
                continue
            # Same >=100 bar as MAE: a lab NGBoost trained on too few records is not
            # shown as a scored model in performance (treated as 'no model').
            n = self.ngb_n_test(lab)
            if n is not None and n < NGB_MIN_N_TEST:
                continue
            rel = reliability_label(m)
            has_corr = lab in self.correlation.columns if hasattr(self.correlation, 'columns') else False
            dist = self.lab_dist.get(lab, {})
            out.append({
                "lab": lab,
                "family": self.family(lab),
                "n_test": fnum(m, "Total"),
                "data_mean": dist.get("mean"),     # population mean of real values
                "data_p5": dist.get("p5"),
                "data_p95": dist.get("p95"),
                "data_n": dist.get("n"),
                # --- value-accuracy axis (teal) ---
                "value_score": rel["value_score"],
                "value_level": rel["value_level"],
                "smape_mean": fnum(m, "SMAPE_mean%"),
                "nrmse": fnum(m, "NRMSE%"),
                "mae": fnum(m, "MAE"),
                "rmse": fnum(m, "RMSE"),
                # --- decision-calibration axis (navy) ---
                "calibration_score": rel["calibration_score"],
                "decision_level": rel["decision_level"],
                "ece": fnum(m, "ECE"),
                "mce": fnum(m, "MCE"),
                "bss_pct": fnum(m, "BSS_%"),
                "has_calibration": calibration_file(lab) is not None,
                "has_correlations": has_corr,
            })
        return out

    def quant_for(self, lab: str) -> float:
        return float(self.quant_steps.get(lab, 0) or 0)

    def labs(self) -> list[dict]:
        """Catalog for the UI: one row per lab with its inputs and panel."""
        out = []
        for lab, scopes in sorted(self._scopes.items()):
            any_key = next(iter(scopes.values()))
            ent = self.entries[any_key]
            has_corr = lab in self.correlation.columns if hasattr(self.correlation, 'columns') else False
            out.append(
                {
                    "lab": lab,
                    "sex_specific": "all" not in scopes,
                    "feature_cols": ent["feature_cols"],
                    "profile_family": ent.get("profile_family"),
                    "has_correlations": has_corr,
                }
            )
        return out


@lru_cache(maxsize=1)
def get_registry() -> Registry:
    return Registry()


# Minimum test-set records for a model to count as "having a model" for a lab.
# Applied symmetrically to NGBoost (here) and MAE (MAE_MIN_N_TEST in mae_adapter):
# below this bar predictions are too data-poor to show in patients / performance /
# stability, so the lab is treated as having no model for that method.
NGB_MIN_N_TEST = 100


def ngboost_available_for(lab: str) -> bool:
    """NGBoost counts as covering a lab only if it has a trained model AND at least
    NGB_MIN_N_TEST test-set records (summed across sex scopes). None count (no metrics
    row) -> available, so a genuine model is never hidden on a lookup miss."""
    reg = get_registry()
    if lab not in reg._scopes:
        return False
    n = reg.ngb_n_test(lab)
    return n is None or n >= NGB_MIN_N_TEST
