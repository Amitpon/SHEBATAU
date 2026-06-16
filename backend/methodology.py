"""Builds the 'explain ourselves' content: a plain-language description of each model
family, the exact computational steps it uses, and the source papers it is based on
(scanned from Professional Articles/<family>/ so new PDFs appear automatically).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTICLES_DIR = ROOT / "Professional Articles"

_EXPLAINERS = {
    "ngboost": {
        "title": "NGBoost - Probabilistic Gradient Boosting",
        "summary": (
            "We adopted the NGBoost framework from Jiang et al. (2024), which predicts a "
            "Normal(mu, sigma) distribution per repeated lab order and computes "
            "P(stable) = Phi(prev + delta) - Phi(prev - delta), recommending cancellation "
            "when P(stable) >= the selected threshold. "
            "We extended their original 7-lab model to all available tests using "
            "Reference Change Value (RCV) thresholds from Westgard/Ricos (2014), replaced "
            "single-holdout calibration with Out-of-Fold Isotonic Regression "
            "(Zadrozny & Elkan 2002), and added prev1 dropout to simulate missing prior results. "
            "Evaluation used a walk-forward simulation in which cancelled tests did not update "
            "the prior result - mirroring real clinical workflow. "
            "We assessed five cancellation thresholds (0.50-0.99). Physician consultations "
            "indicated that confidence below 80% is clinically unacceptable, motivating "
            "higher-threshold operating points."
        ),
        "steps": [
            "Predict a Normal distribution (mean and spread) in a transformed space.",
            "Apply the target transform (e.g. log1p) and invert it by Monte-Carlo sampling.",
            "Clip samples to physiologically plausible bounds (clip_bounds) and round to "
            "the lab's reporting step (quant_step).",
            "Compute P(stable) = probability the value lands within prev +/- stability_threshold "
            "(derived from RCV-based thresholds, Westgard/Ricos 2014).",
            "Calibrate that probability with Out-of-Fold Isotonic Regression so it reflects "
            "observed frequencies (Zadrozny & Elkan 2002).",
            "Walk-forward simulation: cancelled tests do not update the prior result, "
            "matching real-world clinical ordering behavior.",
            "Report NGBoost feature importances explaining each prediction to the clinician.",
            "For panels: draw correlated samples across labs (Gaussian copula on the "
            "lab-correlation matrix) for a joint skip probability.",
        ],
        "advantages": [
            "Predicts a full probability distribution - not just a point estimate.",
            "Calibrated probabilities: P(stable) reflects observed frequencies via "
            "Out-of-Fold Isotonic Regression.",
            "Covers all available lab tests through RCV-based stability thresholds.",
            "Feature importance explains each prediction to the clinician.",
            "Handles skewed distributions via log-transform and Monte Carlo inversion.",
            "Supports joint panel analysis via Gaussian copula on the correlation matrix.",
            "prev1 dropout makes the model robust when a prior result is missing.",
        ],
        "limitations": [
            "Predictions are based on historical patterns - rare clinical events may be underestimated.",
            "Only as good as the features provided; missing vitals reduce accuracy.",
            "Some labs have higher uncertainty (see Performance tab for per-lab metrics).",
            "Sex-specific models require the patient sex field to be present.",
            "Walk-forward simulation does not capture all forms of clinical feedback loops.",
        ],
        # References come straight from the PDF files in Professional Articles/ngboost/
        # (scanned below) - no hand-typed duplicates.
        "references": [],
    },
    "mae": {
        "title": "Masked Autoencoders - Transformer Sequence Model",
        "summary": (
            "For each repeated lab order, the current value was masked and predicted from "
            "prior timestamp-valid context using a Transformer encoder-decoder architecture. "
            "Numeric values were normalized using training-set statistics per lab. "
            "The model was trained with MSE loss on the masked target z-value. "
            "High-variability labs were emphasized using CV-weighted sampling "
            "(CV = train std / |train mean|), so noisy tests contributed more signal during training. "
            "Predictions were converted back to the original scale, and validation residuals "
            "were used to estimate per-lab uncertainty. "
            "Finally, the model calculated P(stable) - the probability that the current value "
            "remains within the lab-specific stability window - and calibrated it with "
            "isotonic regression."
        ),
        "steps": [
            "For each lab order, mask the current value and assemble prior context: "
            "each historical measurement becomes a token with a code embedding "
            "(1,194 codes for labs, vitals, diagnoses, medications, administrative fields), "
            "a type embedding (lab_history, panel_sibling, unrelated_lab, vital, background, "
            "medication, imaging, consultation, ecg, echo, dialysis, administrative, target_mask), "
            "a projected normalized value, and a days-ago projection.",
            "Normalize numeric values using per-lab training-set mean and standard deviation; "
            "apply CV-weighted sampling to up-weight high-variability labs during training.",
            "Encode: a 2-layer Transformer encoder (d_model=64, 2 attention heads, dim_ff=256) "
            "reads all context tokens in parallel and produces context-aware representations "
            "capturing cross-lab and temporal dependencies.",
            "Decode: a 1-layer Transformer decoder receives the masked query token for the "
            "target lab and uses cross-attention over the encoder to predict the next z-value.",
            "Denormalize: invert z-score to original units using per-lab normalizers "
            "stored in the registry.",
            "Estimate uncertainty: use the per-lab empirical residual sigma "
            "(from validation set residuals) to evaluate the Normal CDF over the stability "
            "window and compute P(stable).",
            "Calibrate P(stable) with per-lab isotonic regression calibrators.",
            "Feature attribution: cross-attention weights from the last decoder layer "
            "serve as a proxy for which context tokens were most influential.",
        ],
        "advantages": [
            "Covers 52 labs with at least 100 test records (61 with isotonic calibrators).",
            "Flexible input: handles any number of prior measurements without hand-crafted "
            "feature engineering - more history automatically improves predictions.",
            "Cross-lab context: the encoder sees all available labs simultaneously, learning "
            "co-movement patterns (e.g. Albumin dropping as Bilirubin rises).",
            "CV-weighted sampling focuses training signal on the most variable labs.",
            "Temporal awareness: days-ago projection lets the model weight recent measurements "
            "without explicit time-decay engineering.",
            "Unified architecture: one model across all labs via a shared token vocabulary.",
        ],
        "limitations": [
            "Empirical uncertainty: unlike NGBoost (which predicts a full distribution), "
            "MAE estimates uncertainty from population-level residual sigma - it does not "
            "adapt to the specific patient context.",
            "Approximate importances: cross-attention weights indicate which context tokens "
            "were attended to, not a causal decomposition. Read as 'what context was used', "
            "not 'what drove the value'.",
            "Context window limit: very long patient histories are truncated during tokenization.",
        ],
        "references": [],
    },
}


def _scan_articles(family: str) -> list[str]:
    folder = ARTICLES_DIR / family
    if not folder.exists():
        return []
    return sorted(p.name for p in folder.iterdir() if p.is_file())


def methodology() -> dict:
    families = {}
    for fam, info in _EXPLAINERS.items():
        files = _scan_articles(fam)
        families[fam] = {**info, "reference_files": files}
    return {"families": families}
