"""Orchestrates a single-lab prediction: assemble inputs (patient + edits), run the
chosen model adapter, and score the hidden actual value for the verification panel.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
from scipy.stats import norm

from .models.base import ModelAdapter
from .models.mae_adapter import get_mae_adapter
from .models.ngboost_adapter import get_ngboost_adapter
from .patients import get_patient
from .schemas import PredictRequest

_ADAPTERS = {"ngboost": get_ngboost_adapter, "mae": get_mae_adapter}


def get_adapter(name: str) -> ModelAdapter:
    factory = _ADAPTERS.get(name)
    if factory is None:
        raise ValueError(f"Unknown model: {name!r} (have {sorted(_ADAPTERS)})")
    return factory()


def available_models() -> list[dict]:
    return [{"name": n, "available": f().available} for n, f in _ADAPTERS.items()]


def _finite_float_or_none(value):
    if value is None or value == "" or value == "--":
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def _assemble_inputs(req: PredictRequest):
    """Merge patient record with any UI overrides into (features, sex, prev1, actual)."""
    features: dict = {}
    sex = req.sex
    prev1 = _finite_float_or_none(req.prev1)
    actual = _finite_float_or_none(req.actual_next)

    if req.patient_id:
        patient = get_patient(req.patient_id)
        if patient is None:
            raise ValueError(f"Unknown patient: {req.patient_id!r}")
        sex = sex or patient.get("sex")
        block = (patient.get("labs") or {}).get(req.lab)
        if block:
            features.update(block.get("features", {}))
            # MAE demo patients carry the exact timestamp-safe order-event tokens
            # used by the Transformer. Keep them hidden from the regular UI, but
            # pass them through so MAE does not have to imitate NGBoost features.
            features.update(block.get("mae_features", {}))
            if prev1 is None:
                prev1 = _finite_float_or_none(block.get("prev1"))
            if actual is None:
                actual = _finite_float_or_none(block.get("actual_next"))

    if req.features:
        features.update(req.features)
    if prev1 is None:
        prev1 = _finite_float_or_none(features.get(f"prev1_{req.lab}"))
    if prev1 is None:
        raise ValueError(f"prev1 for {req.lab} is required (no prev1_{req.lab} found).")
    return features, sex, prev1, actual


# public alias (used by the joint-profile Monte-Carlo engine)
assemble_inputs = _assemble_inputs


def _verify(dist: dict, actual: Optional[float], prev1: float, stab_thr: float,
            decision: str) -> Optional[dict]:
    """Score the hidden actual next value against the prediction (demo only)."""
    if actual is None:
        return None
    m, s, yt = dist["m"], dist["s"], dist["y_transform"]
    ta = np.log1p(max(actual, -1 + 1e-9)) if yt == "log1p" else actual
    cdf = float(norm.cdf((ta - m) / s))
    # 'overlap' = how central the actual is in the predictive distribution (100% at median).
    overlap = round(100 * (1 - abs(2 * cdf - 1)), 1)
    actual_stable = abs(actual - prev1) <= stab_thr
    return {
        "actual": round(float(actual), 3),
        "status": "STABLE" if actual_stable else "UNSTABLE",
        "overlap_pct": overlap,
        "percentile": round(100 * cdf, 1),
        "decision_correct": (decision == "skip") == actual_stable,
    }


def predict_single(req: PredictRequest) -> dict:
    # Symmetric >=100-records gate: if NGBoost has too few records (or no model) for
    # this lab, return an unavailable result instead of a data-poor prediction. (MAE
    # gates itself inside MaeAdapter.predict.)
    if req.model == "ngboost":
        from .registry import ngboost_available_for
        if not ngboost_available_for(req.lab):
            return {
                "model": "ngboost", "lab": req.lab, "available": False,
                "message": "No NGBoost model for this lab (or fewer than 100 test records).",
            }
    features, sex, prev1, actual = _assemble_inputs(req)
    adapter = get_adapter(req.model)
    stab_override = (req.stability_overrides or {}).get(req.lab)
    result = adapter.predict(
        req.lab, features, sex, prev1,
        decision_threshold=req.decision_threshold,
        stability_threshold_override=stab_override,
    )
    result.setdefault("prev1", prev1)
    result.setdefault("decision_threshold", req.decision_threshold)
    result["inputs"] = {k: features[k] for k in features}
    dist = result.pop("_dist", None)
    if dist is not None:
        result["verification"] = _verify(
            dist, actual, prev1, result["stability_threshold"], result["decision"]
        )
    return result


def predict_multi(req: "PredictRequest") -> dict:
    """Run prediction for multiple models, return {model_name: result}."""
    model_names = req.models or [req.model]
    results = {}
    for model_name in model_names:
        single_req = req.model_copy(update={"model": model_name, "models": None})
        try:
            results[model_name] = predict_single(single_req)
        except Exception as exc:
            results[model_name] = {
                "model": model_name,
                "lab": req.lab,
                "available": False,
                "message": str(exc),
            }
    return results
