"""FastAPI app: prediction API + serves the static frontend so the whole tool runs
from a single command (run.bat) on http://localhost:8000.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .methodology import methodology
from .references import get_references
from .models.base import SCORING_CONFIG, reliability_label
from .montecarlo import joint_profile
from .patients import list_patients
from .predict import available_models, predict_multi, predict_single
from .registry import CALIB_DIR, NGB_DIR, calibration_file, calibration_files_sex, get_registry
from .schemas import CorrelationRequest, PredictRequest, ProfileRequest

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
NGB_PNG = NGB_DIR / "png"  # pre-rendered summary charts
MAE_PNG = ROOT / "models" / "MAE" / "png"  # pre-rendered MAE summary charts

app = FastAPI(title="Sheba Lab-Value CDSS", version="0.1.0")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/labs")
def labs():
    """Lab catalog for the UI. Each row carries per-model `coverage`, and labs that
    ONLY MAE covers (a model + >=100 test records, no NGBoost model) are appended so
    they appear - and can be marked - in every test list."""
    from .models.mae_adapter import _load_mae_registry, mae_available_for
    from .registry import ngboost_available_for
    reg = get_registry()
    rows = reg.labs()
    ngb_labs = {r["lab"] for r in rows}
    out = []
    for r in rows:
        cov = {"ngboost": ngboost_available_for(r["lab"]), "mae": mae_available_for(r["lab"])}
        # A lab is only selectable if at least one method has a usable model (>=100
        # records). Data-poor labs (e.g. Iron) drop out here and surface in the
        # "no model" section instead.
        if not (cov["ngboost"] or cov["mae"]):
            continue
        r["coverage"] = cov
        out.append(r)
    for lab in sorted(_load_mae_registry().get("lab_columns", [])):
        if lab in ngb_labs or not mae_available_for(lab):
            continue
        out.append({
            "lab": lab,
            "sex_specific": False,
            "feature_cols": [],
            "profile_family": reg.family(lab),
            "has_correlations": False,
            "coverage": {"ngboost": ngboost_available_for(lab), "mae": True},
        })
    return out


@app.get("/api/patients")
def patients():
    return list_patients()


@app.get("/api/models")
def models():
    return available_models()


@app.get("/api/methodology")
def get_methodology():
    return methodology()


@app.get("/api/references")
def references():
    return get_references()


@app.post("/api/predict")
def predict(req: PredictRequest):
    try:
        if req.models and len(req.models) > 1:
            return predict_multi(req)
        return predict_single(req)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/predict_profile")
def predict_profile(req: ProfileRequest):
    try:
        return joint_profile(req)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/panels")
def panels():
    return get_registry().panels()


@app.get("/api/lab_norms")
def lab_norms():
    """Per-lab typical value + plausible range, for input prefill / random-fill."""
    return get_registry().lab_norms()


@app.get("/api/input_schemas")
def input_schemas():
    """Per-lab input contract for BOTH models, so one form feeds both.

    For each lab returns the flat feature names NGBoost needs, the ones MAE needs,
    their union (target-history first), the derived inputs (computed, never typed),
    and which model(s) use each feature. Sex-specific labs union both scopes.
    """
    from .models.mae_adapter import _load_mae_registry, mae_input_features

    reg = get_registry()
    mae_labs = set(_load_mae_registry().get("lab_columns", []))
    ng_cols: dict[str, set] = {}
    for ent in reg.entries.values():
        lab = ent["lab"]
        ng_cols.setdefault(lab, set()).update(ent.get("feature_cols", []) or [])

    derived = {"sex_numeric", "sex_code"}

    def clean(cols):
        return [c for c in cols
                if c not in derived and not c.startswith("mae__") and not c.startswith("mae_time__")]

    out: dict[str, dict] = {}
    for lab in sorted(set(ng_cols) | mae_labs):
        ngc = clean(sorted(ng_cols.get(lab, set())))
        maec = clean(mae_input_features(lab))
        ng_set, mae_set = set(ngc), set(maec)
        union, seen = [], set()
        for c in [*maec, *ngc]:  # MAE list leads with target-lab history
            if c not in seen:
                seen.add(c)
                union.append(c)
        out[lab] = {
            "ngboost": ngc,
            "mae": maec,
            "union": union,
            "derived": sorted(derived),
            "models_by_feature": {
                c: ([m for m in ("ngboost", "mae") if (m == "ngboost" and c in ng_set) or (m == "mae" and c in mae_set)])
                for c in union
            },
        }
    return out


@app.get("/api/performance")
def performance(model: str = Query(default="ngboost")):
    """All-labs headline metrics. model= selects which adapter's data to use."""
    if model == "mae":
        from .models.mae_adapter import mae_performance_table
        return mae_performance_table()
    return get_registry().performance_table()


@app.get("/api/lab/{lab}/performance")
def lab_performance(lab: str, model: str = Query(default="ngboost")):
    """Per-lab metrics + feature importance + top correlations for the Results view."""
    if model == "mae":
        from .models.mae_adapter import mae_lab_performance
        try:
            return mae_lab_performance(lab)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"Lab {lab!r} not in MAE lab_columns")

    reg = get_registry()
    try:
        ent = reg.entry(lab, None)
    except KeyError:
        scopes = reg._scopes.get(lab)
        if not scopes:
            raise HTTPException(status_code=404, detail=f"Unknown lab: {lab}")
        ent = reg.entries[next(iter(scopes.values()))]

    has_corr = lab in reg.correlation.columns if hasattr(reg.correlation, "columns") else False

    # For sex-specific labs (HGB, HCT, RBC, CPK, Methemoglobin): use the weighted
    # average metrics for the headline block, and expose the M/F breakdown separately.
    breakdown = reg.sex_breakdown(lab)
    m = reg.metrics_for(lab, None) or (reg._weighted_metrics(lab, reg._scopes.get(lab, {})) if breakdown else {})

    # NGBoost feature importances per sex scope (static - independent of patient input)
    importances_sex = None
    if breakdown and model == "ngboost":
        from .models.ngboost_adapter import ngb_importances_for_key
        imp = {}
        for scope_info in breakdown:
            sex_code = scope_info["sex"]
            scope_key = reg._scopes.get(lab, {}).get(sex_code)
            if scope_key:
                try:
                    imp[sex_code] = ngb_importances_for_key(scope_key)
                except Exception:
                    pass
        if len(imp) >= 2:
            importances_sex = imp

    return {
        "lab": lab,
        "feature_cols": ent["feature_cols"],
        "profile_family": ent.get("profile_family"),
        "metrics": m,
        "reliability": reliability_label(m),
        "correlations": reg.top_correlations(lab, 8),
        "calibration_url": calibration_file(lab),
        "calibration_urls_sex": calibration_files_sex(lab),
        "has_correlations": has_corr,
        "threshold_curve": reg.threshold_curve(lab),
        "distribution": reg.lab_distribution(lab),
        "sex_breakdown": breakdown,
        "importances_sex": importances_sex,
    }


@app.get("/api/lab_universe")
def lab_universe():
    """Every lab column classified by per-model coverage (>=100-records gate on both).

    Buckets the UI uses (no reasons, organised by model):
      - no_model_data: data-poor labs with NO usable model in EITHER method.
      - no_model_derived: derived/duplicate/qualitative columns we never model by design.
      - ngboost_only / mae_only: labs only one method covers (still selectable).
    Legacy keys (insufficient/unmodeled/excluded*) are kept for backward-compat.
    """
    from .models.mae_adapter import _load_mae_registry, mae_available_for
    from .registry import ngboost_available_for
    reg = get_registry()
    u = reg.lab_universe()
    excluded = set(u.get("excluded", {}).keys())

    # Full universe of lab names across both methods + the unmodeled/excluded columns.
    universe = (set(reg._scopes.keys())
                | set(_load_mae_registry().get("lab_columns", []))
                | excluded
                | set(u.get("insufficient", []))
                | set(u.get("unmodeled", [])))

    no_model, ngb_only, mae_only = [], [], []
    for lab in sorted(universe):
        ng, ma = ngboost_available_for(lab), mae_available_for(lab)
        if ng and ma:
            continue
        if ng:
            ngb_only.append(lab)
        elif ma:
            mae_only.append(lab)
        else:
            no_model.append(lab)

    no_model_derived = sorted(l for l in no_model if l in excluded)
    no_model_data = [l for l in no_model if l not in excluded]

    u["no_model"] = no_model
    u["no_model_data"] = no_model_data
    u["no_model_derived"] = no_model_derived
    u["ngboost_only"] = ngb_only
    u["mae_only"] = mae_only
    # Legacy: insufficient = data-poor no-model labs (not the by-design exclusions).
    u["insufficient"] = no_model_data
    u["unmodeled"] = no_model
    return u


@app.get("/api/scoring_config")
def scoring_config():
    """How the value & decision trust scores are built (weights, BSS mode, bands)."""
    return SCORING_CONFIG


@app.get("/api/stability_thresholds")
def stability_thresholds():
    """Per-lab stability_threshold from registry - used by Settings panel to seed editable inputs."""
    reg = get_registry()
    result = {}
    for key, ent in reg.entries.items():
        lab = ent["lab"]
        thr = ent.get("stability_threshold")
        if thr is not None and lab not in result:
            result[lab] = float(thr)
    return result


@app.get("/api/lab/{lab}/threshold_curve")
def lab_threshold_curve(lab: str):
    """Saved% vs FNR% at thresholds 0.5-0.99 for the threshold-sensitivity chart."""
    curve = get_registry().threshold_curve(lab)
    if not curve:
        raise HTTPException(status_code=404, detail=f"No threshold data for {lab}")
    return {"lab": lab, "points": curve}


@app.get("/api/panel/{panel}/correlations")
def panel_correlations(panel: str):
    """Intra-panel correlation sub-matrix + homogeneity score."""
    result = get_registry().panel_correlations(panel)
    if not result["labs"]:
        raise HTTPException(status_code=404, detail=f"Unknown panel: {panel}")
    return result


@app.post("/api/profile/correlations")
def profile_correlations(req: CorrelationRequest):
    """Correlation sub-matrix + homogeneity for an ad-hoc, user-built profile."""
    return get_registry().profile_correlations(req.labs)


@app.get("/api/lab_model_coverage")
def lab_model_coverage():
    """Returns per-lab availability dict: {lab: {ngboost: bool, mae: bool}}.

    MAE counts as covering a lab only when it also has >=100 test-set records
    (mae_available_for); below that we treat MAE as having no model for the lab.
    """
    from .models.mae_adapter import _load_mae_registry, mae_available_for
    from .registry import ngboost_available_for
    reg = get_registry()
    # Extract unique lab names from NGBoost registry keys (e.g. ALT_all, HGB_M, HGB_F)
    ngb_labs: set[str] = set()
    for key, ent in reg.entries.items():
        ngb_labs.add(ent["lab"])
    mae_reg = _load_mae_registry()
    mae_labs: set[str] = set(mae_reg.get("lab_columns", []))
    all_labs = ngb_labs | mae_labs
    # Both flags use the >=100 test-records gate, so a data-poor model reads as 'no model'.
    return {
        lab: {"ngboost": ngboost_available_for(lab), "mae": mae_available_for(lab)}
        for lab in sorted(all_labs)
    }


# --- static assets (mounted before the catch-all so /api/* and /images/* win) ---
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/images", StaticFiles(directory=str(ROOT / "Images")), name="images")
app.mount("/calibration", StaticFiles(directory=str(CALIB_DIR)), name="calibration")
if NGB_PNG.exists():
    app.mount("/summary_charts", StaticFiles(directory=str(NGB_PNG)), name="summary_charts")
if MAE_PNG.exists():
    app.mount("/mae_summary_charts", StaticFiles(directory=str(MAE_PNG)), name="mae_summary_charts")
app.mount("/Professional Articles", StaticFiles(directory=str(ROOT / "Professional Articles")), name="articles")
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
