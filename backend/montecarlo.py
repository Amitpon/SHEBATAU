"""Joint panel / ad-hoc profile probability.

When a doctor groups several labs into one profile, the clinically meaningful number
is the probability that *all* of them stay stable at once (so the whole draw can be
skipped). Because labs in a panel are correlated, that joint probability is not the
product of the individual ones — we sample them together with a Gaussian copula built
from the trained lab-correlation matrix.

Copula approach (correct):
  Each lab j has a calibrated P(stable_j) = p_j.
  Stability maps to a symmetric event in standard-normal space:
    |Z_j| ≤ c_j  where  c_j = Φ⁻¹((1 + p_j) / 2)
  We draw Z = (Z_1, …, Z_k) from N(0, R) and count how often ALL |Z_j| ≤ c_j.
  This guarantees: marginals match calibrated p_stable, and joint ≥ product when
  correlations are positive (as probability theory requires).
"""
from __future__ import annotations

import numpy as np
from scipy.stats import norm as spnorm

from .predict import assemble_inputs, get_adapter
from .registry import get_registry, ngboost_available_for
from .schemas import ProfileRequest

_N = 40_000
_RNG = np.random.default_rng(20240601)


def _model_correlation(model: str):
    """Correlation matrix for the copula, chosen per model.

    Each model ships its own trained lab-correlation matrix. MAE falls back to the
    NGBoost matrix if its own is unavailable so the joint analysis still runs.
    """
    if model == "mae":
        from .models.mae_adapter import _load_mae_correlation
        corr = _load_mae_correlation()
        if corr is not None:
            return corr
    return get_registry().correlation


def _nearest_psd_cholesky(R: np.ndarray) -> np.ndarray:
    """Cholesky factor of R, repairing tiny non-PSD numerical drift if needed."""
    try:
        return np.linalg.cholesky(R)
    except np.linalg.LinAlgError:
        vals, vecs = np.linalg.eigh(R)
        vals = np.clip(vals, 1e-8, None)
        R2 = vecs @ np.diag(vals) @ vecs.T
        d = np.sqrt(np.diag(R2))
        R2 = R2 / np.outer(d, d)
        return np.linalg.cholesky(R2)


def _correlation_submatrix(labs: list[str], corr) -> np.ndarray:
    """k x k correlation for the selected labs; missing labs default to independent."""
    k = len(labs)
    R = np.eye(k)
    for a in range(k):
        for b in range(a + 1, k):
            la, lb = labs[a], labs[b]
            if la in corr.index and lb in corr.columns:
                val = corr.loc[la, lb]
                if np.isfinite(val):
                    R[a, b] = R[b, a] = float(val)
    return R


def joint_profile(req: ProfileRequest) -> dict:
    if len(req.labs) < 2:
        raise ValueError("A profile needs at least two labs.")

    adapter = get_adapter(req.model)
    per_lab = []
    skipped: list[dict] = []
    for lab in req.labs:
        stab_override = (req.stability_overrides or {}).get(lab)
        # NGBoost >=100-records gate (MAE gates itself inside its adapter, handled below).
        if req.model == "ngboost" and not ngboost_available_for(lab):
            skipped.append({"lab": lab, "reason": "No NGBoost model (or fewer than 100 test records)."})
            continue
        try:
            features, sex, prev1, _ = assemble_inputs(_single(req, lab))
            r = adapter.predict(lab, features, sex, prev1,
                                decision_threshold=req.decision_threshold,
                                stability_threshold_override=stab_override)
        except Exception as exc:  # noqa: BLE001 - one bad lab must not kill the panel
            skipped.append({"lab": lab, "reason": str(exc)})
            continue
        # Some adapters (e.g. MAE) report unavailability instead of raising.
        if not r.get("available", True) or r.get("p_stable") is None:
            skipped.append({"lab": lab, "reason": r.get("message") or f"{req.model} has no model for {lab}."})
            continue
        per_lab.append({"lab": lab, "prev1": prev1, "r": r})

    # Not enough usable labs for THIS model -> return a graceful, explicit result
    # instead of failing, so a dual-model UI can show the other model's answer.
    if len(per_lab) < 2:
        return {
            "model": req.model,
            "available": False,
            "labs": [],
            "skipped": skipped,
            "decision_threshold": req.decision_threshold,
            "message": (
                f"{req.model} could not jointly evaluate this profile "
                f"({len(per_lab)} of {len(req.labs)} labs available)."
            ),
        }

    # correlated standard normals -> per-lab transformed samples
    R = _correlation_submatrix([p["lab"] for p in per_lab], _model_correlation(req.model))
    L = _nearest_psd_cholesky(R)
    Z = _RNG.standard_normal((_N, len(per_lab))) @ L.T

    # Map each lab's calibrated P(stable) to a symmetric interval in standard-normal
    # space: P(|Z_j| ≤ c_j) = p_j  ⟺  c_j = Φ⁻¹((1 + p_j) / 2)
    reg = get_registry()
    stable_cols = []
    labs_out = []
    for j, p in enumerate(per_lab):
        p_cal = float(p["r"]["p_stable"])
        c_j = float(spnorm.ppf(min((1.0 + p_cal) / 2.0, 1.0 - 1e-9)))
        stable = np.abs(Z[:, j]) <= c_j
        stable_cols.append(stable)
        labs_out.append({
            "lab": p["lab"],
            "value": p["r"]["value"],
            "ci95": p["r"]["ci95"],
            "p_stable": p["r"]["p_stable"],
            "p_stable_mc": round(float(stable.mean()), 4),  # should ≈ p_stable
            "stability_window": p["r"]["stability_window"],
            "profile_family": reg.family(p["lab"]),
        })

    stacked = np.vstack(stable_cols)            # k x N
    joint_skip = float(np.all(stacked, axis=0).mean())
    indep = float(np.prod([p["r"]["p_stable"] for p in per_lab]))  # product of calibrated marginals
    skip = joint_skip >= req.decision_threshold

    return {
        "model": req.model,
        "available": True,
        "skipped": skipped,
        "labs": labs_out,
        "joint_skip": round(joint_skip, 4),
        "independent_baseline": round(indep, 4),
        "correlation_effect": round(joint_skip - indep, 4),
        "decision_threshold": req.decision_threshold,
        "decision": "skip" if skip else "repeat",
        "recommendation": (
            "All tests in the profile are jointly likely stable - the panel can be skipped."
            if skip else
            "At least one test in the profile is likely to move - draw the panel."
        ),
        "n_samples": _N,
    }


def _single(req: ProfileRequest, lab: str):
    """Build a per-lab PredictRequest from the profile request (reuses input assembly)."""
    from .schemas import PredictRequest
    overrides = (req.features or {}).get(lab)
    return PredictRequest(
        lab=lab,
        patient_id=req.patient_id,
        features=overrides,
        decision_threshold=req.decision_threshold,
        model=req.model,
    )
