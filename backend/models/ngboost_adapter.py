"""NGBoost adapter — turns a trained NGBRegressor into the unified prediction dict.

Pipeline (verified against the artifacts):
  1. load <key>.pkl (NGBRegressor) + <key>_calibrator.pkl (IsotonicRegression) via joblib
  2. X = features in registry order  ->  dist = model.pred_dist(X)  -> loc m, scale s
     (m, s live in the *transformed* space, e.g. log1p)
  3. display value/CI: sample from Normal(m, s), inverse-transform, clip, summarise
  4. stability P_raw: analytic Normal CDF over the stability window (transformed) -> calibrate
  5. feature importance: feature_importances_[0] (the loc row), normalised
  6. reliability: from pipeline_results.csv metrics
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
from scipy.stats import norm

from ..registry import PKL_DIR, get_registry
from .base import ModelAdapter, reliability_label

_N_SAMPLES = 20_000
_RNG = np.random.default_rng(20240601)  # fixed seed -> reproducible UI numbers


@lru_cache(maxsize=256)
def _load(key: str):
    model = joblib.load(PKL_DIR / f"{key}.pkl")
    cal_path = PKL_DIR / f"{key}_calibrator.pkl"
    calibrator = joblib.load(cal_path) if cal_path.exists() else None
    return model, calibrator


def _fwd(x, y_transform: str):
    """Original-units -> model space."""
    if y_transform == "log1p":
        return np.log1p(np.clip(x, -1 + 1e-9, None))
    return x


def _inv(x, y_transform: str):
    """Model space -> original units."""
    if y_transform == "log1p":
        return np.expm1(x)
    return x


class NGBoostAdapter(ModelAdapter):
    name = "ngboost"
    available = True

    def predict(
        self,
        lab: str,
        features: dict,
        sex: Optional[str],
        prev1: float,
        decision_threshold: float = 0.85,
        stability_threshold_override: Optional[float] = None,
    ) -> dict:
        reg = get_registry()
        key = reg.resolve_key(lab, sex)
        ent = reg.entries[key]
        feature_cols = ent["feature_cols"]
        y_transform = ent.get("y_transform", "none")
        stab_thr = stability_threshold_override if stability_threshold_override is not None else float(ent["stability_threshold"])
        cutoff = float(ent.get("confidence_cutoff", 0.5))

        missing = [c for c in feature_cols if c not in features]
        if missing:
            raise ValueError(f"Missing inputs for {lab}: {missing}")

        model, calibrator = _load(key)
        X = np.array([[float(features[c]) for c in feature_cols]], dtype=float)
        dist = model.pred_dist(X)
        m = float(np.ravel(dist.loc)[0])
        s = float(np.ravel(dist.scale)[0])

        # --- display value + CI (sampling handles the non-linear inverse + clip) ---
        draws = _inv(_RNG.normal(m, s, _N_SAMPLES), y_transform)
        clip = reg.clip_for(lab)
        if clip:
            draws = np.clip(draws, clip[0], clip[1])
        draws = np.clip(draws, 0, None)  # lab values are always non-negative
        mu = float(np.mean(draws))
        sigma = float(np.std(draws))
        ci = [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))]
        quant = reg.quant_for(lab)
        value = round(mu / quant) * quant if quant else mu

        # --- stability probability over [max(0, prev1-thr), prev1+thr], analytic in model space ---
        lo, hi = max(0.0, prev1 - stab_thr), prev1 + stab_thr
        z_lo = (_fwd(lo, y_transform) - m) / s
        z_hi = (_fwd(hi, y_transform) - m) / s
        p_raw = float(norm.cdf(z_hi) - norm.cdf(z_lo))
        if calibrator is not None:
            p_stable = float(np.clip(calibrator.predict([p_raw])[0], 0.0, 1.0))
        else:
            p_stable = p_raw
        stable = p_stable >= decision_threshold

        # --- feature importance (loc row), normalised to % ---
        fi = np.asarray(model.feature_importances_)
        loc_row = fi[0] if fi.ndim == 2 else fi
        total = float(loc_row.sum()) or 1.0
        importances = [
            {"feature": c, "pct": round(100 * float(w) / total, 1)}
            for c, w in zip(feature_cols, loc_row)
        ]
        importances.sort(key=lambda d: d["pct"], reverse=True)

        return {
            "model": self.name,
            "lab": lab,
            "key": key,
            "available": True,
            "value": round(value, 3),
            "quant_step": quant,  # lab's reporting step, for display rounding
            "mu": round(mu, 3),
            "sigma": round(sigma, 3),
            "ci95": [round(ci[0], 3), round(ci[1], 3)],
            "prev1": prev1,
            "stability_window": [round(lo, 3), round(hi, 3)],
            "stability_threshold": stab_thr,
            "p_stable": round(p_stable, 4),
            "p_raw": round(p_raw, 4),
            "decision_threshold": decision_threshold,
            "confidence_cutoff": cutoff,
            "decision": "skip" if stable else "repeat",
            "recommendation": (
                "Likely stable - repeat test can be safely skipped."
                if stable
                else "Predicted unstable - repeating the test is recommended."
            ),
            "importances": importances,
            "reliability": reliability_label(reg.metrics_for(lab, sex)),
            # raw distribution params so the verification panel can score an actual value
            "_dist": {"m": m, "s": s, "y_transform": y_transform, "clip": list(clip) if clip else None},
        }


def ngb_importances_for_key(key: str) -> list[dict]:
    """Static NGBoost feature importances for a registry key.
    NGBoost feature_importances_ are input-independent, so this is safe to call
    without patient data - useful for showing M vs F importance side by side.
    """
    from ..registry import get_registry
    reg = get_registry()
    model, _ = _load(key)
    feature_cols = reg.entries.get(key, {}).get("feature_cols", [])
    fi = np.asarray(model.feature_importances_)
    loc_row = fi[0] if fi.ndim == 2 else fi
    total = float(loc_row.sum()) or 1.0
    return sorted(
        [{"feature": c, "pct": round(100 * float(w) / total, 1)} for c, w in zip(feature_cols, loc_row)],
        key=lambda d: -d["pct"],
    )


@lru_cache(maxsize=1)
def get_ngboost_adapter() -> NGBoostAdapter:
    return NGBoostAdapter()
