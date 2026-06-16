"""Masked Autoencoders (MAE) adapter - Transformer encoder-decoder for lab prediction.

Architecture (from state_dict + mae_config.json)
-------------------------------------------------
  d_model=64, n_heads=2, encoder_layers=2, decoder_layers=1, dim_ff=256
  - code_emb  [n_codes, 64]  one slot per feature token (Lab__prev1, panel__ALT__latest, ...)
  - type_emb  [13, 64]       13 type slots; only IDs 0-3 are used (enabled_token_types)
  - value_proj [64,1] / time_proj [64,1]  project scalar to d_model
  - mask_type_emb [1, 64]   replaces type_emb for the target query token
  - head  LayerNorm -> Linear(64,64) -> ReLU -> Linear(64,1)

Input sequence construction (from mae_registry.json)
-----------------------------------------------------
Each token = code_emb(code_id) + type_emb(type_id) + value_proj(norm_val) + time_proj(days)

  Token type IDs (mae_registry.json does not store this mapping explicitly;
  based on the 12 feature families vs 4 type slots the assumed grouping is):
    0 = lab_history   (Lab__prev1, Lab__first_admission, Lab__delta, ...)
    1 = vital          (vital__pulse__latest, vital__sbp__latest, ...)
    2 = administrative (age, sex_numeric, days_in_admission, ...)
    3 = background     (charlson__, dx_chapter__, med__atc1__, consult__, ...)

  If this mapping is wrong the model will still produce predictions but with
  reduced accuracy. Supply models/MAE/type_ids.json to override:
    {"lab_history": 0, "vital": 1, "administrative": 2, "background": 3}

Feature mapping  NGBoost (flat dict)  ->  MAE token codes
  prev1_{Lab}          ->  {Lab}__prev1
  first_in_adm_{Lab}   ->  {Lab}__first_admission
  computed delta        ->  {Lab}__delta  (prev1 - first_in_adm)
  prev1_{Lab} also      ->  {Lab}__latest
  pulse                 ->  vital__pulse__latest
  sbp                   ->  vital__sbp__latest
  dbp                   ->  vital__dbp__latest
  age                   ->  age
  sex (M/F)             ->  sex_numeric  (1=M, 0=F)
  days_in_admission     ->  days_in_admission

Required artifacts (never edit trained files):
  models/MAE/mae_model.pt              state_dict (torch.save(model.state_dict(), ...))
  models/MAE/mae_registry.json         code_to_id, normalizers, sigma_by_lab, lab_columns
  models/MAE/pkl/mae_sigmas.pkl        per-lab residual sigma (fallback if not in registry)
  models/MAE/pkl/mae_calibrators.pkl   per-lab IsotonicRegression calibrators

Optional:
  models/MAE/mae_pipeline_results.csv  performance metrics for reliability scores in UI
  models/MAE/type_ids.json             override type-category assignments
"""
from __future__ import annotations

import warnings
from functools import lru_cache
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import joblib
import numpy as np
import pandas as pd
from scipy.stats import norm

from ..registry import get_registry
from .base import ModelAdapter, reliability_label

ROOT    = Path(__file__).resolve().parent.parent.parent
MAE_DIR = ROOT / "models" / "MAE"
MAE_PKL = MAE_DIR / "pkl"

# ── torch (graceful import) ───────────────────────────────────────────────────
try:
    import torch
    import torch.nn as nn
    _TORCH_OK = True
except ImportError:
    _TORCH_OK = False

# ── token-type category mapping ───────────────────────────────────────────────
# Type IDs are fixed by the trained model's TYPE_NAMES list in order_event_dataset.py.
# Defined in models/MAE/token_type_mapping_notes.md:
#   0=target_mask, 1=lab_history, 2=panel_sibling, 3=unrelated_lab, 4=vital,
#   5=background_disease, 6=medication, 7=imaging, 8=consultation,
#   9=ecg, 10=echo, 11=dialysis, 12=administrative
_DEFAULT_TYPE_MAP: dict[str, int] = {
    "lab_history":       1,
    "panel_sibling":     2,
    "unrelated_lab":     3,
    "vital":             4,
    "background_disease": 5,
    "medication":        6,
    "imaging":           7,
    "consultation":      8,
    "ecg":               9,
    "echo":              10,
    "dialysis":          11,
    "administrative":    12,
}

# ── model class (matches state_dict exactly) ──────────────────────────────────
if _TORCH_OK:
    class LabMAE(nn.Module):
        """Masked Autoencoder Transformer for lab value prediction.

        Reads from mae_config.json at import time:
          d_model=64, n_heads=2, encoder_layers=2, decoder_layers=1, dim_ff=256
        """
        def __init__(
            self,
            n_codes: int = 78,
            n_types: int = 4,
            d_model: int = 96,
            nhead:   int = 4,   # from mae_config.json n_heads
            n_enc:   int = 3,
            n_dec:   int = 2,
            dim_ff:  int = 384,
        ):
            super().__init__()
            self.code_emb      = nn.Embedding(n_codes, d_model)
            self.type_emb      = nn.Embedding(n_types, d_model)
            self.value_proj    = nn.Linear(1, d_model)
            self.time_proj     = nn.Linear(1, d_model)
            enc_layer          = nn.TransformerEncoderLayer(
                d_model, nhead, dim_ff, batch_first=True, dropout=0.0)
            self.encoder       = nn.TransformerEncoder(enc_layer, n_enc)
            dec_layer          = nn.TransformerDecoderLayer(
                d_model, nhead, dim_ff, batch_first=True, dropout=0.0)
            self.decoder       = nn.TransformerDecoder(dec_layer, n_dec)
            self.mask_type_emb = nn.Embedding(1, d_model)
            self.head          = nn.Sequential(
                nn.LayerNorm(d_model),
                nn.Linear(d_model, d_model),
                nn.ReLU(),
                nn.Linear(d_model, 1),
            )

        def forward(
            self,
            src_codes:  "torch.Tensor",   # [B, S]   long  - feature code ids
            src_types:  "torch.Tensor",   # [B, S]   long  - type category ids
            src_values: "torch.Tensor",   # [B, S]   float - normalised feature values
            src_times:  "torch.Tensor",   # [B, S]   float - days delta per token
            tgt_code:   "torch.Tensor",   # [B, 1]   long  - target lab code id
            tgt_time:   "torch.Tensor",   # [B, 1]   float - days since last measurement
            src_key_padding_mask: "torch.Tensor | None" = None,  # [B, S] bool
        ) -> "torch.Tensor":              # [B, 1]  predicted value
            B = src_codes.shape[0]
            src = (self.code_emb(src_codes)
                   + self.type_emb(src_types)
                   + self.value_proj(src_values.unsqueeze(-1))
                   + self.time_proj(src_times.unsqueeze(-1)))
            memory = self.encoder(src, src_key_padding_mask=src_key_padding_mask)
            zero   = torch.zeros(B, 1, dtype=torch.long, device=tgt_code.device)
            tgt    = (self.code_emb(tgt_code)
                      + self.mask_type_emb(zero)
                      + self.time_proj(tgt_time.unsqueeze(-1)))
            out    = self.decoder(tgt, memory)
            return self.head(out.squeeze(1))

# ── artifact loaders (cached) ─────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load_mae_registry() -> dict:
    import json
    path = MAE_DIR / "mae_registry.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _load_feature_token_types() -> dict[str, str]:
    path = MAE_DIR / "mae_feature_registry.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, usecols=["feature_code", "token_type"])
    except Exception:
        return {}
    df = df.dropna(subset=["feature_code", "token_type"])
    return {str(r.feature_code): str(r.token_type) for r in df.itertuples(index=False)}


@lru_cache(maxsize=1)
def _load_sigmas_fallback() -> dict:
    """Fallback sigma dict from pkl (large residuals in original units)."""
    path = MAE_PKL / "mae_sigmas.pkl"
    if not path.exists():
        return {}
    return joblib.load(path)


@lru_cache(maxsize=1)
def _load_calibrators() -> dict:
    path = MAE_PKL / "mae_calibrators.pkl"
    if not path.exists():
        return {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return joblib.load(path)


@lru_cache(maxsize=1)
def _load_model():
    """Instantiate LabMAE and load state_dict from mae_model.pt."""
    if not _TORCH_OK:
        return None
    path = MAE_DIR / "mae_model.pt"
    if not path.exists():
        return None
    try:
        sd      = torch.load(str(path), map_location="cpu", weights_only=False)
        n_codes = sd["code_emb.weight"].shape[0]
        n_types = sd["type_emb.weight"].shape[0]
        # Read architecture from mae_config.json (registry lacks these keys)
        import json as _json
        cfg_path = MAE_DIR / "mae_config.json"
        cfg = _json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
        d_model = cfg.get("d_model", 64)
        nhead   = cfg.get("n_heads",  2)
        n_enc   = cfg.get("encoder_layers", 2)
        n_dec   = cfg.get("decoder_layers", 1)
        dim_ff  = int(round(d_model * 4))   # 256 for d_model=64
        model   = LabMAE(n_codes=n_codes, n_types=n_types, d_model=d_model,
                         nhead=nhead, n_enc=n_enc, n_dec=n_dec, dim_ff=dim_ff)
        model.load_state_dict(sd)
        model.eval()
        return model
    except Exception as exc:
        print(f"[mae_adapter] Failed to load mae_model.pt: {exc}")
        return None


@lru_cache(maxsize=1)
def _load_type_overrides() -> dict:
    import json
    path = MAE_DIR / "type_ids.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _load_type_map() -> dict[str, int]:
    """Build type-category map using the trained 13-slot TYPE_NAMES order.

    `enabled_token_types` controls which families were used during training; it is
    not the integer ID order. The embedding IDs are fixed by order_event_dataset.py.
    """
    return {**_DEFAULT_TYPE_MAP, **_load_type_overrides()}


@lru_cache(maxsize=1)
def _load_mae_metrics() -> dict:
    """Per-lab metrics. Prefers enriched CSV (full metrics) over basic pipeline results."""
    import csv
    enriched_085 = MAE_DIR / "mae_pipeline_results_enriched_threshold_085.csv"
    enriched_path = MAE_DIR / "mae_pipeline_results_enriched.csv"
    basic_path    = MAE_DIR / "mae_pipeline_results.csv"
    path = enriched_085 if enriched_085.exists() else enriched_path if enriched_path.exists() else basic_path
    if not path.exists():
        return {}
    out: dict = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            lab = (row.get("Lab") or "").strip()
            if not lab:
                continue
            out[lab] = {
                "SMAPE_med%":          row.get("SMAPE_med%"),
                "SMAPE_mean%":         row.get("SMAPE_mean%"),
                "ROC_AUC":             row.get("ROC_AUC"),
                "MAE":                 row.get("MAE"),
                "RMSE":                row.get("RMSE"),
                "NRMSE%":              row.get("NRMSE%"),
                "ECE":                 row.get("ECE"),
                "MCE":                 row.get("MCE"),
                "BSS_%":               row.get("BSS_%"),
                "mean_val":            row.get("mean_val"),
                "Total":               row.get("Total"),
                "Saved%":              row.get("Saved%"),
                "FNR%":                row.get("FNR%"),
                "FN_among_cancelled%": row.get("FN_among_cancelled%"),
                "Base_Stability_%":    row.get("Base_Stability_%"),
            }
    # Merge calibration_by_lab.csv (ECE/MCE if not already present)
    calib_path = MAE_DIR / "calibration_by_lab.csv"
    if calib_path.exists():
        with open(calib_path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                lab = (row.get("Lab") or "").strip()
                if not lab or lab not in out:
                    continue
                if not out[lab].get("ECE") and row.get("ECE"):
                    out[lab]["ECE"] = row.get("ECE")
                if not out[lab].get("MCE") and row.get("MCE"):
                    out[lab]["MCE"] = row.get("MCE")
    return out


@lru_cache(maxsize=1)
def _load_mae_threshold_data() -> dict[str, list[dict]]:
    import csv
    path = MAE_DIR / "mae_pipeline_results_thresholds.csv"
    if not path.exists():
        return {}
    out: dict[str, list[dict]] = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            lab = (row.get("Lab") or "").strip()
            if not lab:
                continue
            try:
                point = {
                    "threshold": float(row["Threshold"]),
                    "saved_pct": float(row.get("Saved%", 0)),
                    "fnr_pct": float(row.get("FNR%", 0)),
                    "ece": float(row.get("ECE_wf", row.get("ECE", 0))),
                    "brier": float(row.get("Brier_wf", row.get("Brier_Model", 0))),
                    "bss_pct": float(row.get("BSS%_wf", row.get("BSS_%", 0))),
                }
            except (TypeError, ValueError):
                continue
            out.setdefault(lab, []).append(point)
    return out


def _mae_threshold_curve(lab: str) -> list[dict]:
    points = sorted(_load_mae_threshold_data().get(lab, []), key=lambda p: p["threshold"])
    kept_saved = None
    for p in points:
        sv = p["saved_pct"]
        if kept_saved is not None and sv > kept_saved + 1e-9:
            p["anomaly"] = True
        else:
            p["anomaly"] = False
            kept_saved = sv
    return points


@lru_cache(maxsize=1)
def _load_mae_distributions() -> dict:
    import json
    path = MAE_DIR / "mae_lab_distributions.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


@lru_cache(maxsize=1)
def _load_mae_correlation():
    path = MAE_DIR / "global_lab_correlation.csv"
    if not path.exists():
        return None
    try:
        return pd.read_csv(path, index_col=0)
    except Exception:
        return None


def _mae_top_correlations(lab: str, n: int = 8) -> list[dict]:
    corr = _load_mae_correlation()
    if corr is None or lab not in corr.columns:
        return []
    series = pd.to_numeric(corr[lab], errors="coerce").drop(labels=[lab], errors="ignore").dropna()
    series = series[series.abs() < 0.999]
    ranked = series.reindex(series.abs().sort_values(ascending=False).index)
    return [{"lab": k, "r": round(float(v), 3)} for k, v in ranked.head(n).items()]


def _mae_calibration_url(lab: str) -> str | None:
    calib_dir = ROOT / "calibration" / "mae"
    if not calib_dir.exists():
        return None
    low = lab.lower()
    for f in sorted(calib_dir.iterdir()):
        if not f.is_file() or f.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
            continue
        stem = f.stem.lower()
        if stem == low or stem.startswith(low + "_") or stem.startswith(low):
            rel = f.relative_to(ROOT / "calibration")
            return f"/calibration/{quote(str(rel).replace(chr(92), '/'))}"
    return None


# ── helpers ───────────────────────────────────────────────────────────────────

def _normalize(val: float, feature_code: str, normalizers: dict) -> float:
    """Z-score normalise a feature value using training statistics."""
    n = normalizers.get(feature_code)
    if n is None:
        return val
    mean, std = float(n["mean"]), float(n["std"])
    return (val - mean) / max(std, 1e-9)


def _inv_normalize(val: float, feature_code: str, normalizers: dict) -> float:
    """Reverse z-score normalisation for the output prediction."""
    n = normalizers.get(feature_code)
    if n is None:
        return val
    mean, std = float(n["mean"]), float(n["std"])
    return val * std + mean


def _fwd(x: float, y_transform: str) -> float:
    if y_transform == "log1p":
        return float(np.log1p(max(x, -1 + 1e-9)))
    return float(x)


def _inv(x: float, y_transform: str) -> float:
    if y_transform == "log1p":
        return float(np.expm1(x))
    return float(x)


# ── adapter ───────────────────────────────────────────────────────────────────

def _safe_float(v):
    if v is None or v == '' or v == '--':
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def _safe_int(v):
    if v is None or v == '' or v == '--':
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _finite_float_or_none(v):
    return _safe_float(v)


def _display_token_name(raw_name: str) -> str:
    """Human-readable MAE token label for the demo UI."""
    if raw_name.endswith("__prev1"):
        return f"Previous {raw_name[:-7]} value"
    if raw_name.endswith("__prev2"):
        return f"Second previous {raw_name[:-7]} value"
    if raw_name.endswith("__prev3"):
        return f"Third previous {raw_name[:-7]} value"
    if raw_name.endswith("__first_admission"):
        return f"First admission {raw_name[:-17]} value"
    if raw_name.endswith("__latest"):
        base = raw_name[:-8]
        if base.startswith("panel__"):
            return f"Previous same-panel lab: {base[7:]}"
        if base.startswith("unrelated__"):
            return f"Previous unrelated lab: {base[11:]}"
        if base.startswith("vital__"):
            return f"Previous vital: {base[7:]}"
        return f"Latest previous {base} value"
    if raw_name.endswith("__delta"):
        return f"Delta from first admission: {raw_name[:-7]}"
    if raw_name == "sex_numeric":
        return "Sex"
    if raw_name == "days_in_admission":
        return "Days in admission"
    return raw_name.replace("__", " ").replace("_", " ")


# A MAE model is only trusted when it has enough held-out test records. Below this
# many, we treat MAE as having NO model for that lab (don't show its results).
MAE_MIN_N_TEST = 100


def _mae_n_test(lab: str):
    """Held-out test-set size for this lab from the MAE metrics CSV (Total)."""
    return _safe_int(_load_mae_metrics().get(lab, {}).get("Total"))


def mae_available_for(lab: str) -> bool:
    """True only when MAE has a usable model for this lab: it is a trained column
    AND has at least MAE_MIN_N_TEST test records (enough to trust the evaluation)."""
    if lab not in set(_load_mae_registry().get("lab_columns", [])):
        return False
    n = _mae_n_test(lab)
    return n is not None and n >= MAE_MIN_N_TEST


def mae_input_features(lab: str) -> list[str]:
    """Flat UI feature names the MAE model actually consumes for this lab.

    Mirrors MaeAdapter.predict's token construction, but expressed as the flat
    feature names the UI collects (so the same form feeds both models). Only codes
    that exist in this model's vocabulary (code_to_id) are included, so the list is
    the genuine MAE input set - which differs from NGBoost (e.g. MAE adds prev2/prev3
    and same-panel siblings; it has no vitals tokens in the current artifact).
    """
    if not mae_available_for(lab):
        return []  # no trusted MAE model for this lab -> collect no MAE inputs
    reg = _load_mae_registry()
    code_to_id = reg.get("code_to_id", {})
    if not code_to_id:
        return []
    has = lambda c: c in code_to_id  # noqa: E731
    lab_columns = set(reg.get("lab_columns", []))
    cols: list[str] = []
    if lab in lab_columns or has(f"{lab}__prev1") or has(f"{lab}__latest"):
        cols += [f"prev1_{lab}", f"first_in_adm_{lab}", f"days_since_last_{lab}"]
    if has(f"{lab}__prev2"):
        cols.append(f"prev2_{lab}")
    if has(f"{lab}__prev3"):
        cols.append(f"prev3_{lab}")
    # vitals - only if the trained artifact actually carries these token codes
    for ng_key, code in (("pulse", "vital__pulse__latest"),
                         ("sbp", "vital__sbp__latest"),
                         ("dbp", "vital__dbp__latest")):
        if has(code):
            cols.append(ng_key)
    if has("age"):
        cols.append("age")
    if has("days_in_admission"):
        cols.append("days_in_admission")
    # same-panel siblings (MAE attends to other labs in the same panel)
    ngb = get_registry()
    fam = ngb.family(lab)
    if fam:
        for sib in ngb.panels().get(fam, []):
            if sib == lab:
                continue
            if has(f"panel__{sib}__latest") or has(f"unrelated__{sib}__latest"):
                cols.append(f"prev1_{sib}")
    # de-dup preserving order
    seen, out = set(), []
    for c in cols:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def mae_performance_table() -> list[dict]:
    """All-labs MAE metrics in the same flat shape as NGBoost's Registry.performance_table()."""
    mae_reg  = _load_mae_registry()
    metrics  = _load_mae_metrics()
    labs     = mae_reg.get("lab_columns", [])
    sigma_by = mae_reg.get("sigma_by_lab", {})
    dists    = _load_mae_distributions()
    ngb_reg  = get_registry()
    corr     = _load_mae_correlation()
    out = []
    for lab in sorted(labs):
        if not mae_available_for(lab):
            continue  # <100 test records -> treat as no MAE model, omit from the table
        row = metrics.get(lab, {})
        dist = dists.get(lab, {})
        has_corr = corr is not None and lab in corr.columns
        m: dict = {}
        if row:
            m = {
                "SMAPE_mean%": _safe_float(row.get("SMAPE_mean%")),
                "SMAPE_med%":  _safe_float(row.get("SMAPE_med%")),
                "NRMSE%":      _safe_float(row.get("NRMSE%")),
                "MAE":         _safe_float(row.get("MAE")),
                "ROC_AUC":     _safe_float(row.get("ROC_AUC")),
                "ECE":         _safe_float(row.get("ECE")),
                "MCE":         _safe_float(row.get("MCE")),
                "BSS_%":       _safe_float(row.get("BSS_%")),
                "mean_val":    _safe_float(row.get("mean_val")),
                "Total":       row.get("Total"),
            }
        if lab in sigma_by:
            m["sigma_by_lab"] = float(sigma_by[lab])
        rel = reliability_label(m)
        out.append({
            "lab":               lab,
            "family":            ngb_reg.family(lab),
            "n_test":            _safe_int(row.get("Total")) if row else 0,
            "value_score":       rel.get("value_score"),
            "value_level":       rel.get("value_level"),
            "smape_mean":        _safe_float(row.get("SMAPE_mean%")) if row else None,
            "smape_med":         _safe_float(row.get("SMAPE_med%")) if row else None,
            "nrmse":             _safe_float(row.get("NRMSE%")) if row else None,
            "mae":               _safe_float(row.get("MAE")) if row else None,
            "rmse":              _safe_float(row.get("RMSE")) if row else None,
            "calibration_score": rel.get("calibration_score"),
            "decision_level":    rel.get("decision_level"),
            "ece":               _safe_float(row.get("ECE")) if row else None,
            "mce":               _safe_float(row.get("MCE")) if row else None,
            "bss_pct":           _safe_float(row.get("BSS_%")) if row else None,
            "roc_auc":           _safe_float(row.get("ROC_AUC")) if row else None,
            "has_calibration":   _mae_calibration_url(lab) is not None or bool(row.get("ECE") or row.get("MCE")),
            "has_correlations":  has_corr,
            "data_mean":         dist.get("mean") if dist else _safe_float(row.get("mean_val")) if row else None,
            "data_p5":           dist.get("p5") if dist else None,
            "data_p95":          dist.get("p95") if dist else None,
            "data_n":            dist.get("n") if dist else None,
            "saved_pct":         _safe_float(row.get("Saved%")) if row else None,
            "fn_rate_pct":       _safe_float(row.get("FNR%")) if row else None,
            "fn_cancelled_pct":  _safe_float(row.get("FN_among_cancelled%")) if row else None,
            "base_stability_pct": _safe_float(row.get("Base_Stability_%")) if row else None,
        })
    return out


def mae_lab_performance(lab: str) -> dict:
    """Per-lab MAE metrics in the same shape as /api/lab/{lab}/performance (NGBoost)."""
    mae_reg  = _load_mae_registry()
    metrics  = _load_mae_metrics()
    labs     = mae_reg.get("lab_columns", [])
    if lab not in labs:
        raise KeyError(f"{lab!r} not in MAE lab_columns")
    if not mae_available_for(lab):
        raise KeyError(f"{lab!r} has <{MAE_MIN_N_TEST} MAE test records - no reliable model")
    row      = metrics.get(lab, {})
    sigma_by = mae_reg.get("sigma_by_lab", {})
    ngb_reg  = get_registry()
    corrs    = _mae_top_correlations(lab, 8)
    calib_url = _mae_calibration_url(lab)
    dist = _load_mae_distributions().get(lab, {})
    full_m = {
        # value accuracy
        "SMAPE_mean%":  _safe_float(row.get("SMAPE_mean%")) if row else None,
        "SMAPE_med%":   _safe_float(row.get("SMAPE_med%")) if row else None,
        "NRMSE%":       _safe_float(row.get("NRMSE%")) if row else None,
        "MAE":          _safe_float(row.get("MAE")) if row else None,
        "RMSE":         _safe_float(row.get("RMSE")) if row else None,
        "mean_val":     _safe_float(row.get("mean_val")) if row else None,
        # calibration / decision
        "ROC_AUC":      _safe_float(row.get("ROC_AUC")) if row else None,
        "ECE":          _safe_float(row.get("ECE")) if row else None,
        "MCE":          _safe_float(row.get("MCE")) if row else None,
        "BSS_%":        _safe_float(row.get("BSS_%")) if row else None,
        # operational
        "Total":        row.get("Total") if row else None,
        "Saved%":       _safe_float(row.get("Saved%")) if row else None,
        "FNR%":         _safe_float(row.get("FNR%")) if row else None,
        "Base_Stability_%": _safe_float(row.get("Base_Stability_%")) if row else None,
    }
    if lab in sigma_by:
        full_m["sigma_by_lab"] = float(sigma_by[lab])
    return {
        "lab":              lab,
        "model":            "mae",
        "feature_cols":     [],   # MAE uses token sequences, not a fixed feature vector
        "profile_family":   ngb_reg.family(lab),
        "metrics":          full_m,
        "reliability":      reliability_label(full_m),
        "correlations":     corrs,
        "calibration_url":  calib_url,
        "has_calibration":  calib_url is not None or bool(row and (row.get("ECE") or row.get("MCE"))),
        "has_correlations": bool(corrs),
        "threshold_curve":  _mae_threshold_curve(lab),
        "distribution":     dist,
        "saved_pct":        _safe_float(row.get("Saved%")) if row else None,
        "fn_rate_pct":      _safe_float(row.get("FNR%")) if row else None,
        "fn_cancelled_pct": _safe_float(row.get("FN_among_cancelled%")) if row else None,
        "base_stability_pct": _safe_float(row.get("Base_Stability_%")) if row else None,
    }


class MaeAdapter(ModelAdapter):
    """Masked Autoencoders adapter - sequence-based lab prediction."""
    name = "mae"

    @property
    def available(self) -> bool:
        if not _TORCH_OK:
            return False
        reg = _load_mae_registry()
        if not reg.get("code_to_id"):
            return False
        return _load_model() is not None

    def predict(
        self,
        lab: str,
        features: dict,
        sex: Optional[str],
        prev1: float,
        decision_threshold: float = 0.85,
        stability_threshold_override: Optional[float] = None,
    ) -> dict:
        if not _TORCH_OK:
            return self._unavailable(lab, "torch not installed")
        mae_reg = _load_mae_registry()
        if not mae_reg:
            return self._unavailable(lab, "mae_registry.json not found in models/MAE/")

        lab_columns: list = mae_reg.get("lab_columns", [])
        if lab not in lab_columns:
            return self._unavailable(
                lab,
                f"{lab} is not in MAE lab_columns. Supported: {', '.join(sorted(lab_columns))}",
            )

        # Too few held-out test records -> we do not trust a MAE model for this lab.
        n_test = _mae_n_test(lab)
        if n_test is None or n_test < MAE_MIN_N_TEST:
            return self._unavailable(
                lab, f"only {n_test or 0} MAE test records (<{MAE_MIN_N_TEST}) - no reliable model for this lab")

        model = _load_model()
        if model is None:
            return self._unavailable(lab, "mae_model.pt could not be loaded")

        # --- NGBoost registry for stability config ----------------------------
        ngb_reg     = get_registry()
        try:
            key       = ngb_reg.resolve_key(lab, sex)
            ngb_entry = ngb_reg.entries[key]
        except KeyError:
            ngb_entry = {}

        y_transform  = ngb_entry.get("y_transform", "none")
        stab_thr     = float(stability_threshold_override if stability_threshold_override is not None
                             else ngb_entry.get("stability_threshold", 0.0))
        conf_cutoff  = float(ngb_entry.get("confidence_cutoff",   0.85))
        quant        = ngb_entry.get("quant_step") or ngb_reg.quant_for(lab) or None

        # --- build token sequence from flat features dict --------------------
        code_to_id  = mae_reg["code_to_id"]
        normalizers = mae_reg.get("normalizers", {})
        type_map    = _load_type_map()

        src_codes_l: list[int]   = []
        src_types_l: list[int]   = []
        src_values_l: list[float] = []
        src_times_l: list[float] = []

        def _add(code: str, raw_val: float, days: float = 0.0, fam: str = "lab_history"):
            raw_val = _finite_float_or_none(raw_val)
            days = _finite_float_or_none(days)
            if raw_val is None or days is None:
                return
            cid = code_to_id.get(code)
            if cid is None:
                return  # code not in this model's vocabulary
            tid = type_map.get(fam, 0)
            if cid in src_codes_l:
                i = src_codes_l.index(cid)
                src_types_l[i] = tid
                src_values_l[i] = _normalize(raw_val, code, normalizers)
                src_times_l[i] = float(days)
                return
            src_codes_l.append(cid)
            src_types_l.append(tid)
            src_values_l.append(_normalize(raw_val, code, normalizers))
            src_times_l.append(float(days))

        # Exact MAE order-event tokens from demo patient JSONs. These are the
        # preferred inputs for MAE; the flat NGBoost-style fields below are only
        # fallback/override conveniences for manual edits.
        token_types = _load_feature_token_types()
        for feat_key, feat_val in features.items():
            if not feat_key.startswith("mae__"):
                continue
            code = feat_key[len("mae__"):]
            fam = token_types.get(code)
            if fam is None:
                if code.startswith("panel__"):
                    fam = "panel_sibling"
                elif code.startswith("unrelated__"):
                    fam = "unrelated_lab"
                elif code.startswith("vital__"):
                    fam = "vital"
                elif code in {"age", "sex_numeric", "days_in_admission", "prior_lab_orders", "prior_admissions"}:
                    fam = "administrative"
                else:
                    fam = "lab_history"
            recency = features.get(f"mae_time__{code}", 0.0)
            _add(code, feat_val, days=recency, fam=fam)

        # Lab history tokens for the target lab
        prev1_feature = _finite_float_or_none(features.get(f"prev1_{lab}"))
        prev1_val = prev1_feature if prev1_feature is not None else _finite_float_or_none(prev1)
        if prev1_val is None:
            return self._unavailable(lab, "No finite previous value is available for this lab.")

        fim_feature = _finite_float_or_none(features.get(f"first_in_adm_{lab}"))
        fim_val = fim_feature if fim_feature is not None else prev1_val
        days_feature = _finite_float_or_none(features.get(f"days_since_last_{lab}"))
        days_last = days_feature if days_feature is not None else 1.0

        _add(f"{lab}__prev1",           prev1_val,            days=days_last, fam="lab_history")
        _add(f"{lab}__first_admission", fim_val,              days=0.0,       fam="lab_history")
        _add(f"{lab}__latest",          prev1_val,            days=days_last, fam="lab_history")
        if fim_feature is not None:
            _add(f"{lab}__delta",       prev1_val - fim_val,  days=days_last, fam="lab_history")

        # Vitals (map NGBoost flat names to MAE vital token codes)
        vital_map = {
            "pulse": "vital__pulse__latest",
            "sbp":   "vital__sbp__latest",
            "dbp":   "vital__dbp__latest",
        }
        for ng_key, mae_code in vital_map.items():
            val = _finite_float_or_none(features.get(ng_key))
            if val is not None:
                _add(mae_code, val, fam="vital")

        # Administrative features
        age_val = _finite_float_or_none(features.get("age"))
        if age_val is not None:
            _add("age", age_val, fam="administrative")

        sex_numeric = 1.0 if sex == "M" else 0.0 if sex == "F" else 0.5
        _add("sex_numeric", sex_numeric, fam="administrative")

        admit_days = _finite_float_or_none(features.get("days_in_admission"))
        if admit_days is not None:
            _add("days_in_admission", admit_days, fam="administrative")

        # Panel sibling tokens (other labs in same panel, from features)
        for feat_key, feat_val in features.items():
            feat_val = _finite_float_or_none(feat_val)
            if feat_val is None:
                continue
            if feat_key.startswith("prev1_") and not feat_key.endswith(f"_{lab}"):
                other_lab = feat_key[len("prev1_"):]
                # Try as panel sibling first, then as unrelated
                mae_code = f"panel__{other_lab}__latest"
                if mae_code in code_to_id:
                    _add(mae_code, feat_val, fam="panel_sibling")
                else:
                    mae_code2 = f"unrelated__{other_lab}__latest"
                    if mae_code2 in code_to_id:
                        _add(mae_code2, feat_val, fam="unrelated_lab")

        # Historical depth tokens (prev2, prev3) for the target lab
        for depth in [2, 3]:
            key = f"prev{depth}_{lab}"
            val = _finite_float_or_none(features.get(key))
            if val is not None:
                code = f"{lab}__prev{depth}"
                if code in code_to_id:
                    _add(code, val, fam="lab_history")

        if not src_codes_l:
            return self._unavailable(lab, "No valid input tokens could be constructed.")

        # --- forward pass (captures last-decoder-layer inputs for attribution) --
        try:
            codes_t  = torch.tensor([src_codes_l],  dtype=torch.long)
            types_t  = torch.tensor([src_types_l],  dtype=torch.long)
            values_t = torch.tensor([src_values_l], dtype=torch.float32)
            times_t  = torch.tensor([src_times_l],  dtype=torch.float32)

            tgt_code_id = code_to_id.get(lab, code_to_id.get(f"{lab}__latest", 0))
            tgt_code_t  = torch.tensor([[tgt_code_id]], dtype=torch.long)
            tgt_time_t  = torch.tensor([[0.0]],         dtype=torch.float32)

            # PyTorch's TransformerDecoder calls multihead_attn with need_weights=False,
            # so the hook captures None weights. Instead we capture the *inputs* to the
            # last decoder layer via pre_hook, then manually call multihead_attn with
            # need_weights=True after the main forward.
            _last_inputs: list = []
            def _pre_hook(module, inp):
                if len(inp) >= 2:
                    _last_inputs.append((inp[0].detach(), inp[1].detach()))

            _handle = model.decoder.layers[-1].register_forward_pre_hook(_pre_hook)
            try:
                with torch.no_grad():
                    out_t = model(codes_t, types_t, values_t, times_t, tgt_code_t, tgt_time_t)
                    pred_raw = float(out_t.squeeze().item())
            finally:
                _handle.remove()

        except Exception as exc:
            return self._unavailable(lab, f"Forward pass failed: {exc}")

        # --- attribution: cross-attention weights -> importances --------------
        importances: list[dict] = []
        if _last_inputs:
            try:
                tgt_in, mem_in = _last_inputs[0]
                last = model.decoder.layers[-1]
                with torch.no_grad():
                    # Replicate the self-attention block that runs before cross-attention.
                    # PyTorch >= 2.0 exposes _sa_block; older versions do not.
                    try:
                        sa_out = last._sa_block(tgt_in,
                                                attn_mask=None,
                                                key_padding_mask=None,
                                                is_causal=False)
                        q = last.norm1(tgt_in + sa_out)
                    except (AttributeError, TypeError):
                        sa_out = last.self_attn(tgt_in, tgt_in, tgt_in)[0]
                        q = last.norm1(tgt_in + last.dropout1(sa_out))

                    _, attn_w = last.multihead_attn(
                        q, mem_in, mem_in,
                        need_weights=True,
                        average_attn_weights=True,
                    )

                if attn_w is not None:
                    weights = attn_w.squeeze().cpu().numpy()   # [S]
                    if weights.ndim == 0:
                        weights = np.array([float(weights)])
                    if len(weights) == len(src_codes_l):
                        id_to_code = {v: k for k, v in code_to_id.items()}
                        seen: dict[str, float] = {}
                        for cid, wt in zip(src_codes_l, weights.tolist()):
                            raw_name = id_to_code.get(cid, f"code_{cid}")
                            display  = _display_token_name(raw_name)
                            seen[display] = seen.get(display, 0.0) + float(wt)
                        importances = sorted(
                            [{"feature": k, "pct": round(v * 100, 1)} for k, v in seen.items()],
                            key=lambda x: -x["pct"],
                        )
            except Exception:
                pass  # attribution failure never blocks the prediction

        # --- denormalise prediction ------------------------------------------
        # The model predicts a normalised value; reverse using target lab normalizer.
        mu_orig = _inv_normalize(pred_raw, lab, normalizers)

        if not np.isfinite(mu_orig):
            return {
                "model":     self.name,
                "lab":       lab,
                "available": False,
                "error":     f"MAE produced non-finite prediction for {lab} - check token context or normalizer values",
            }

        # --- sigma (registry sigma_by_lab preferred; fallback to pkl) --------
        sigma_reg = mae_reg.get("sigma_by_lab", {})
        sigma_orig = float(sigma_reg.get(lab, _load_sigmas_fallback().get(lab, 1.0)))

        if not np.isfinite(sigma_orig) or sigma_orig <= 0:
            sigma_orig = 1.0  # fallback - sigma invalid but prediction can still continue

        # --- P(stable) in original-units space --------------------------------
        # Lower bound clamped to 0 — lab values are always non-negative.
        _lo = max(0.0, prev1_val - stab_thr)
        _hi = prev1_val + stab_thr
        p_raw = float(
            norm.cdf((_hi - mu_orig) / max(sigma_orig, 1e-9))
            - norm.cdf((_lo - mu_orig) / max(sigma_orig, 1e-9))
        )
        p_raw = float(np.clip(p_raw, 0.0, 1.0))

        calibrators = _load_calibrators()
        cal = calibrators.get(lab)
        if cal is not None:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                p_stable = float(np.clip(cal.predict([p_raw])[0], 0.0, 1.0))
        else:
            p_stable = p_raw

        stable    = p_stable >= decision_threshold
        confident = p_stable >= conf_cutoff or p_stable <= (1.0 - conf_cutoff)

        # --- CI (MC from Normal(mu, sigma) in original units) -----------------
        rng          = np.random.default_rng(42)
        samples      = rng.normal(mu_orig, sigma_orig, 10_000)
        clip         = ngb_entry.get("clip")
        if clip:
            samples  = np.clip(samples, clip[0], clip[1])
        samples      = np.clip(samples, 0, None)  # lab values are always non-negative
        mu_orig      = max(0.0, mu_orig)
        ci_lo        = float(np.percentile(samples, 2.5))
        ci_hi        = float(np.percentile(samples, 97.5))

        def qr(v: float) -> float:
            if not quant:
                return round(float(v), 4)
            r   = round(v / quant) * quant
            dec = len(str(quant).rstrip("0").split(".")[-1]) if "." in str(quant) else 0
            return round(r, dec)

        mu_q  = qr(mu_orig)
        ci_lo = qr(ci_lo)
        ci_hi = qr(ci_hi)

        # --- reliability (from mae_pipeline_results.csv) ----------------------
        mae_metrics = _load_mae_metrics()
        row = mae_metrics.get(lab, {})
        rel_dict: dict = {}
        if row:
            rel_dict = {
                # value accuracy metrics - required by reliability_label for value_score
                "SMAPE_mean%":          row.get("SMAPE_mean%"),
                "SMAPE_med%":           row.get("SMAPE_med%"),
                "NRMSE%":               row.get("NRMSE%"),
                "MAE":                  row.get("MAE"),
                "mean_val":             row.get("mean_val"),
                # calibration / decision metrics - required for calibration_score
                "ECE":                  row.get("ECE"),
                "MCE":                  row.get("MCE"),
                "BSS_%":                row.get("BSS_%"),
                "ROC_AUC":              row.get("ROC_AUC"),
                # operational context
                "Total":                row.get("Total"),
                "Saved%":               row.get("Saved%"),
                "FN_per_total%":        row.get("FN_per_total%"),
                "FN_among_cancelled%":  row.get("FN_among_cancelled%"),
            }
        rel = reliability_label(rel_dict)

        return {
            "model":               self.name,
            "lab":                 lab,
            "available":           True,
            "value":               mu_q,
            "mu":                  mu_q,
            "sigma":               round(sigma_orig, 4),
            "ci95":                [ci_lo, ci_hi],
            "prev1":               round(float(prev1_val), 4),
            "p_stable":            round(p_stable, 4),
            "p_stable_raw":        round(p_raw, 4),
            "decision":            "skip" if stable else "repeat",
            "decision_threshold":   decision_threshold,
            "confident":           confident,
            "stability_threshold": stab_thr,
            "stability_window":    [round(max(0.0, prev1_val - stab_thr), 3), round(prev1_val + stab_thr, 3)],
            "quant_step":          quant,
            "importances":         importances,
            "reliability":         rel,
            "_dist": {
                "m":           mu_orig,
                "s":           sigma_orig,
                "y_transform": "none",   # sigma already in original units
                "clip":        list(clip) if clip else None,
            },
        }

    @staticmethod
    def _unavailable(lab: str, reason: str) -> dict:
        return {
            "model":     "mae",
            "lab":       lab,
            "available": False,
            "message":   f"Masked Autoencoders: {reason}.",
        }


@lru_cache(maxsize=1)
def get_mae_adapter() -> MaeAdapter:
    return MaeAdapter()
