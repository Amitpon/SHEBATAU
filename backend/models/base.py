"""Model-adapter interface + shared result shaping.

Every model family (NGBoost today, MAE later) implements ``ModelAdapter.predict`` and
returns the same dict shape, so the API, the frontend and the panel Monte-Carlo stay
model-agnostic and a side-by-side comparison is trivial.
"""
from __future__ import annotations

import abc
from typing import Optional


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# Scoring configuration - the SINGLE source of truth for how the two 0-100
# trust scores are built. Exposed via /api/scoring_config so a settings screen
# can show (and later tune) it. Every input is a real metric from the CSV.
# ---------------------------------------------------------------------------
SCORING_CONFIG = {
    "value": {
        # Both are error metrics (0 = perfect); we invert and combine them.
        # NRMSE weighted higher: it punishes big misses, which are the dangerous
        # ones clinically. SMAPE is normalised over its 0-200% range.
        "smape_w": 0.4,
        "nrmse_w": 0.6,
    },
    "decision": {
        # Average calibration quality (ECE + MCE), then gated by skill (BSS).
        "ece_w": 0.5,
        "mce_w": 0.5,
        # BSS handling. "gate" (recommended): a model no better than guessing
        # (BSS<=0) is pulled down, a model with real skill (BSS>=bss_full_at)
        # gets full credit, and BSS=0 keeps `bss_floor` of the calibration score
        # so a well-calibrated model is not zeroed outright. "multiply": the
        # strict calib * max(0, BSS) (kept available, but it crushes most labs).
        "bss_mode": "gate",
        "bss_full_at": 0.20,   # BSS fraction at which skill credit saturates to 1
        "bss_floor": 0.5,      # multiplier retained when BSS == 0
    },
    # Doctor-facing confidence bands (score 0-100 -> label + colour). Single scheme
    # used across the whole app: >=90 excellent, >=75 very good, >=50 reasonable, <=49 poor.
    # Lowered from 60 to 50 (2026-06) so every lab returns at least one of
    # {value, probability} from its best model - no lab is left with nothing to show.
    "bands": [
        {"min": 90, "label": "excellent",  "color": "#15803d"},
        {"min": 75, "label": "very good",  "color": "#65a30d"},
        {"min": 50, "label": "reasonable", "color": "#d97706"},
        {"min": 0,  "label": "poor",       "color": "#dc2626"},
    ],
}


def score_band(score) -> dict:
    """Map a 0-100 score to its doctor-facing confidence band."""
    if score is None:
        return {"label": "Unknown", "color": "#9ca3af"}
    for b in SCORING_CONFIG["bands"]:
        if score >= b["min"]:
            return {"label": b["label"], "color": b["color"]}
    return SCORING_CONFIG["bands"][-1]


def value_score_from(smape, nrmse, cfg=None) -> Optional[float]:
    """0-100 'how close is the predicted number to reality'.

    SMAPE_score = 1 - SMAPE/200 ; NRMSE_score = max(0, 1 - NRMSE/100). The weighted
    blend (NRMSE heavier) is scaled to 0-100. If only one metric is available, its
    weight is promoted to 1.0 so a missing metric is not treated as perfect.
    """
    if smape is None and nrmse is None:
        return None
    c = (cfg or SCORING_CONFIG)["value"]
    if smape is not None and nrmse is not None:
        smape_s = _clamp(1.0 - smape / 200.0)
        nrmse_s = _clamp(1.0 - nrmse / 100.0)
        score = c["smape_w"] * smape_s + c["nrmse_w"] * nrmse_s
    elif nrmse is not None:
        score = _clamp(1.0 - nrmse / 100.0)
    else:
        score = _clamp(1.0 - smape / 200.0)
    return round(100.0 * score)


def calibration_score_from(ece, mce, bss, cfg=None) -> Optional[float]:
    """0-100 'how much can we trust the stated skip/repeat probability'.

    Calibration = w_ece*(1-ECE) + w_mce*(1-MCE). This is then gated by skill (BSS):
    a model no better than a naive baseline is untrustworthy even if calibrated, but
    a well-calibrated model with modest skill is NOT zeroed (see bss_mode in config).
    """
    if ece is None and mce is None and bss is None:
        return None
    c = (cfg or SCORING_CONFIG)["decision"]
    # Only include metrics that are actually present; rescale weights accordingly.
    parts, total_w = [], 0.0
    if ece is not None:
        parts.append(c["ece_w"] * _clamp(1.0 - ece))
        total_w += c["ece_w"]
    if mce is not None:
        parts.append(c["mce_w"] * _clamp(1.0 - mce))
        total_w += c["mce_w"]
    if not parts:
        # Only BSS available: use BSS directly as the calibration proxy
        bss_frac = _clamp(bss / 100.0 if bss is not None else 0.0)
        return round(100.0 * bss_frac)
    calib = sum(parts) / total_w  # renormalise so missing metric doesn't lower the score

    bss_frac = (bss if bss is not None else 0.0) / 100.0
    if c["bss_mode"] == "multiply":
        factor = max(0.0, bss_frac)
    else:  # "gate"
        floor, full = c["bss_floor"], c["bss_full_at"]
        factor = _clamp(floor + (bss_frac / full) * (1.0 - floor))
    return round(100.0 * calib * factor)


def reliability_label(metrics: dict) -> dict:
    """Translate the trained-model metrics into a plain-language reliability note.

    Two independent axes (a lab can classify stability well yet predict a noisy value):
      * value reliability  - how accurate the predicted number is (SMAPE / NRMSE)
      * decision/calibration reliability - how trustworthy the stated probability is
        (ECE / MCE / BSS)
    Each axis also gets a single 0-100 score for the UI. All numbers are read from
    pipeline_results.csv; the scores are deterministic rescalings, never invented.
    """
    def fnum(key):
        try:
            return float(metrics.get(key, ""))
        except (TypeError, ValueError):
            return None

    smape = fnum("SMAPE_mean%")
    nrmse = fnum("NRMSE%")
    roc = fnum("ROC_AUC")
    ece = fnum("ECE")
    mce = fnum("MCE")
    bss = fnum("BSS_%")

    value_score = value_score_from(smape, nrmse)
    calibration_score = calibration_score_from(ece, mce, bss)

    # Levels (drive the badge colours) are derived from the scores so the words and
    # the numbers always agree: >=75 high, >=60 moderate, else low.
    def _level(score):
        if score is None:
            return "unknown"
        return "high" if score >= 75 else "moderate" if score >= 60 else "low"

    value_level = _level(value_score)
    value_text = {
        "high": "The model predicts this value accurately.",
        "moderate": "The model is moderately accurate for this value.",
        "low": "This lab is noisy - treat the predicted value with caution.",
        "unknown": "No value-accuracy metric available.",
    }[value_level]

    dec_level = _level(calibration_score)
    dec_text = {
        "high": "The stated stable/repeat probability is well calibrated and skillful.",
        "moderate": "The stated probability is roughly calibrated.",
        "low": "The stated probability is weakly calibrated or barely better than guessing.",
        "unknown": "No calibration metric available.",
    }[dec_level]

    return {
        "value_level": value_level,
        "value_text": value_text,
        "value_score": value_score,
        "value_band": score_band(value_score),
        "decision_level": dec_level,
        "decision_text": dec_text,
        "calibration_score": calibration_score,
        "calibration_band": score_band(calibration_score),
        "metrics": {
            "SMAPE_mean_pct": smape,
            "SMAPE_med_pct": fnum("SMAPE_med%"),
            "NRMSE_pct": nrmse,
            "ROC_AUC": roc,
            "ECE": ece,
            "MCE": mce,
            "BSS_pct": bss,
            "MAE": fnum("MAE"),
            "mean_val": fnum("mean_val"),  # population avg, to contextualise MAE
            "n_test": fnum("Total"),
        },
    }


class ModelAdapter(abc.ABC):
    """Common contract for all model families."""

    name: str = "base"
    available: bool = True

    @abc.abstractmethod
    def predict(
        self,
        lab: str,
        features: dict,
        sex: Optional[str],
        prev1: float,
        decision_threshold: float = 0.85,
        stability_threshold_override: Optional[float] = None,
    ) -> dict:
        """Return the unified prediction dict (mu, sigma, ci, p_stable, decision, ...)."""
        raise NotImplementedError
