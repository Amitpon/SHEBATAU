# Sheba Lab-Value Prediction (שיבא)

## Project Overview
A clinical decision-support tool for Sheba Medical Center that predicts the next value
of a lab test for an admitted patient and recommends **whether the test is worth repeating**.
The doctor picks which tests they care about, enters the patient's history (first/last
result, days since last test, vitals, etc.), and the tool returns, per test:
a predicted value, a **confidence interval**, a **repeat / don't-repeat recommendation**,
and an explicit statement of **how reliable the model is for that specific lab** (some labs
are very noisy and the UI must say so).

Models are probabilistic (NGBoost today, MAE-embedding and others to follow). The user can
pick a model or **compare models side-by-side**.

Status: **active build**. Backend is functional for all 60 labs (prediction, panels/joint
Monte-Carlo, per-lab performance). Frontend exists as a mockup-faithful single-lab screen;
it is being expanded into a multi-section app (see "Target app structure" below).
This is a real clinical-support project — accuracy claims and "how strong is the model"
messaging must come from the metrics files, never invented.

## Tech Stack
- **Backend:** Python (FastAPI) — loads the `.pkl` models, serves predictions as JSON,
  and also serves the static frontend so the whole thing runs from **one command**.
  Chosen so the project is portable: hand it to a colleague, they run `run.bat` and open
  `localhost:8000` — no Node, no build step.
- **Frontend:** static **HTML / CSS / vanilla JS**, talks to the backend via `fetch`.
- **ML:** `ngboost` (probabilistic regression → mean + variance → CI + Monte Carlo),
  `scikit-learn`, `numpy`, `pandas`, `joblib`/`pickle`.
- Python 3.11 (matches the installed interpreter that holds `ngboost`).

## Dev Commands
- `run.bat` → `uvicorn backend.main:app --port 8000`, then open http://localhost:8000
  (Python is `C:\Users\amit\AppData\Local\Programs\Python\Python311\python.exe`).
- `pip install -r requirements.txt` → only `fastapi` + `uvicorn` are new; the ML stack is preinstalled.
- `python scripts/build_demo_patients.py` → regenerate demo patients from a raw export
  (requires a raw export at `data/patients/patients.csv` or `data.csv`; private, see privacy note).
- Tests (once added): `pytest`.

## Built API (backend/main.py)
- `GET  /api/labs` — catalog (lab, feature_cols, profile_family, sex_specific)
- `GET  /api/patients` — demo patients (self-contained JSON)
- `GET  /api/models` — model adapters + availability
- `GET  /api/panels` — profile_family → member labs (CBC/BG_chem/BG_gas)
- `GET  /api/lab_norms` — per-lab `{typical, low, high, spread}` for input prefill / random-fill
  (typical=`mean_val_te`, range=`clip_bounds`, spread=`rmse_te`; real data, never invented)
- `GET  /api/methodology` — per-model explainer + references (scans Professional Articles/)
- `GET  /api/lab/{lab}/performance` — metrics + reliability + feature_cols + top |r| correlations
- `POST /api/predict` — single lab; accepts `decision_threshold` (default 0.85)
- `POST /api/predict_profile` — joint skip-probability for 2+ labs (Gaussian-copula Monte-Carlo)

## Architecture

```
שיבא/
├── CLAUDE.md
├── requirements.txt            # only fastapi+uvicorn are new
├── run.bat                     # one-command launch (uvicorn on :8000)
├── scripts/
│   └── build_demo_patients.py  # derive model features from a raw export -> demo JSON
├── backend/                    # FastAPI app
│   ├── main.py                 # app + all routes + serves frontend & /images
│   ├── models/                 # ADAPTER layer (code), one per model family
│   │   ├── base.py             # ModelAdapter interface + reliability_label()
│   │   ├── ngboost_adapter.py  # pred_dist -> mu/sigma/CI, calibrated P(stable), importances
│   │   └── mae_adapter.py      # MAE adapter - complete (see Model status below)
│   ├── registry.py             # loads registry.json + helpers, panels(), top_correlations()
│   ├── predict.py              # input assembly + single-lab orchestration + verification
│   ├── montecarlo.py           # joint panel skip-prob via Gaussian copula on correlations
│   ├── methodology.py          # model explainers + scans Professional Articles/
│   └── schemas.py              # pydantic PredictRequest / ProfileRequest
├── frontend/                   # multi-section static UI; English; no build step
│   ├── index.html              # 3-section nav (Patient/Models/Performance) + Sheba logo header + partners footer
│   ├── css/styles.css          # design tokens (spacing/shadow), medical-grade theme
│   └── js/                     # app(bootstrap) nav patient models performance charts gauge dist-chart
├── data/patients/              # SELF-CONTAINED demo patients (*.json); data.csv is private
├── Professional Articles/      # source papers per family (ngboost/*.pdf) — read-only
├── Images/                     # partner logos (served at /images)
└── models/                     # >>> TRAINED ARTIFACTS LIVE HERE (see below) <<<
    ├── ngboost/
    │   ├── registry.json       # per-lab config + strength metrics (SOURCE OF TRUTH)
    │   ├── pipeline_results.csv # richer per-lab performance (ROC_AUC, Brier, SMAPE…)
    │   ├── global_lab_correlation.csv/.pkl
    │   └── pkl/                 # the model + calibrator .pkl files
    └── MAE/                     # MAE-embedding models - complete (see Model status below)
```

> Note: backend code lives in `backend/models/` (adapters); trained **artifacts** live in
> top-level `models/`. Don't confuse the two.

## Model artifacts — where files go
All trained artifacts go under `models/<family>/`. For NGBoost:
- **Per-lab model:** `models/ngboost/pkl/<Lab>_<scope>.pkl`
  - `<scope>` is `all`, or `M`/`F` for sex-specific labs (e.g. `HGB_M.pkl`, `CPK_F.pkl`).
- **Per-lab calibrator:** `models/ngboost/pkl/<Lab>_<scope>_calibrator.pkl`
- **Shared helpers** (already present): `clip_bounds.pkl`, `quant_steps.pkl`,
  `family_confusion.pkl`, `global_lab_correlation.pkl`.
- **Registry:** `models/ngboost/registry.json` — keep this in sync; it is the contract
  between the artifacts and the backend.

New model family (e.g. MAE): drop artifacts in `models/MAE/`, add a `registry.json` in the
same shape, and add one adapter in `backend/models/`. No other code should need to change.

## registry.json — the contract (per lab key, e.g. `LDL_all`)
- `lab`, `sex` (`null` | `"M"` | `"F"`)
- `feature_cols` — **exact inputs the UI must collect** for this lab
  (e.g. `prev1_LDL`, `first_in_adm_LDL`, `days_since_last_LDL`, cross-lab/vitals like `pulse`).
- `profile_family` — panel grouping (`"CBC"`, `"BG_chem"`, `"BG_gas"`, or `null`).
- `stability_threshold`, `confidence_cutoff` — drive the repeat / don't-repeat decision.
- `y_transform` (`log1p`|`none`), `quant_step` — apply when forming the predicted value.
- Strength metrics: `mae_te`, `rmse_te`, `smape_med_te`, `smape_mean_te`, `nrmse_te`,
  `mean_val_te`, `n_test`. **These feed the "how reliable is this model" message.**

`pipeline_results.csv` adds: `ROC_AUC`, `BSS_%`, `ECE`/`MCE`, `Brier_*`, `Saved%`, `FNR%`,
`Base_Stability_%`. Use `ROC_AUC`/`BSS` for *decision* quality and `SMAPE`/`NRMSE` for
*value* quality — a lab can be a good stability classifier yet a noisy value predictor
(e.g. Troponin: high ROC_AUC, very high SMAPE).

## Panels (profile_family)
Tests in a panel are normally ordered together. If the doctor only needs a subset, run a
**Monte Carlo** over just those labs using `global_lab_correlation` to respect cross-lab
dependence. Known families:
- **CBC** — 18 labs (HGB, HCT, RBC, WBC, PLT, MCV, RDW, MPV, the `*_abs` differentials, …)
- **BG_chem** — 5 labs
- **BG_gas** — 10 labs
- Many labs have `profile_family: null` → standalone.

## Two outputs per test (don't collapse them)
1. **Decision** — repeat vs don't-repeat, from the stability classifier
   (`stability_threshold` + `confidence_cutoff`, quality = ROC_AUC/BSS).
2. **Predicted value + CI** — from the probabilistic regressor (quality = SMAPE/NRMSE).
Always show the per-lab reliability alongside, in the doctor's language.

## Target app structure (multi-section frontend — being built)
A top navigation with these sections (references/articles always reachable at the bottom):
1. **Patient** — pick a demo patient (or enter data), choose which tests to order, get the
   per-test prediction (the current CDSS screen) and define ad-hoc profiles for a joint
   skip-probability. This is the main clinical flow.
2. **Models** — an explainer per model family: how it was trained, its limitations and its
   advantages (NGBoost today; MAE-embedding next). Backed by `/api/methodology`.
3. **Results / Performance** — per lab (or other grouping): all calibration metrics
   (MAE, RMSE, BSS, ECE, SMAPE, NRMSE, ROC_AUC…), so we can show which labs we can
   "sign off as good" vs which are little better than a guess; the **feature importance**
   driving each lab; and the labs with the highest **|correlation|** to the selected lab.
   Also browse any panel (known or hand-made) by accuracy and correlations.
   Backed by `/api/lab/{lab}/performance`, `/api/panels`, `/api/labs`.
- **Informative graphs everywhere** (distribution, gauge, correlation bars, metric charts).

## Stop Rules
- NEVER invent accuracy/reliability numbers — read them from `registry.json` /
  `pipeline_results.csv`. Wrong clinical confidence is the worst failure mode here.
- NEVER edit, move, or overwrite files under `models/` — they are trained artifacts.
- NEVER hardcode a lab list in code — read it from `registry.json` so new models appear
  automatically.
- NEVER skip `y_transform` / `quant_step` / calibrator when forming a displayed value.
- PRIVACY: the raw export `data/patients/patients.csv` (or `data.csv`) is real (de-identified)
  patient data and must NEVER be committed or shipped. The file also carries free-text columns
  (diagnoses, department names) that the build script does NOT copy. Demo patients under
  `data/patients/*.json` are synthetic-named and
  self-contained; only generate them via `scripts/build_demo_patients.py`, never copy IDs,
  hashes, real dates, MRNs or free-text.
- Git-tracked, remote is `https://github.com/Amitpon/SHEBATAU.git`. Only commit/push when
  the user explicitly asks; stage files one by one (never `git add -A`/`.`), never commit
  `.claude/`, log files, or `data/patients/patients.csv`/`data.csv`.
- NEVER install packages without listing them and asking first.

## Clinical Mode (frontend/js/app.js, patient.js, dist-chart.js)
A doctor-facing display mode (default; toggle to "Detailed" in Settings, persisted in
`localStorage`). Strips raw numbers/curves down to plain-language tiers so the UI never
implies more precision than the model actually has:
- **Reliability bands** (single source of truth, 0-100 score -> tier): `>=90` excellent,
  `>=75` very good, `>=50` reasonable, `<50` poor. Defined in `backend/models/base.py`
  (`SCORING_CONFIG`) and mirrored in `frontend/js/app.js` (`QUALITY`, `CLINICAL_BANDS_DEFAULT`)
  and `frontend/js/performance.js` (`XMODEL_POOR/GOOD/EXCELLENT`) - keep all three in sync if
  the cutoff ever changes again. The "poor" cutoff was lowered from 60 to 50 (2026-06) so every
  lab returns at least a value or a probability from its best model (none are left with nothing
  to show); only the calibration *or* the value axis needs to clear 50, not both.
- **Two independent axes per lab**: `value_score` (is the predicted number trustworthy) and
  `calibration_score` (is the stated skip/repeat probability trustworthy). `calibration_score
  < ok` forces the displayed decision to REPEAT regardless of the model's raw call
  (`clinicalCalibTier().forceRepeat`); `value_score < ok` hides the predicted value entirely.
- **Panel/tube flag chip** (`_panelFlagCount()` in patient.js): counts labs in a panel that are
  forced-repeat, have a hidden value, or where the two models disagree - shown as "X of Y
  flagged" / "all clear" next to the panel's compact row.
- 3-state icon (not color-only): filled circle = high/good, half circle = ok, triangle = poor.
- Model-disagreement flag uses a different icon/color (indigo balance scale) than the
  poor-reliability warning (red triangle) - they call for different clinical responses.

## Model status (last updated 2026-06-18)

### NGBoost - COMPLETE
- 60 labs, all modelled. `models/ngboost/`
- Full metrics: ROC_AUC, BSS, ECE, MCE, Brier, SMAPE, NRMSE per lab
- Threshold sweep: `pipeline_results_thresholds.csv` (6 thresholds x 60 labs)
- Calibration PNGs: `calibration/ngboost/` (67 per-lab + 3 panel + global + summary)
- Summary overview charts: `models/ngboost/png/` (5 PNG files)
- Feature importances: from `feature_importances_[0]` (NGBoost native)
- Frontend: fully wired in Patient, Sensitivity, Performance sections

### Masked Autoencoders (MAE) - COMPLETE
- Architecture: Transformer enc-dec (d_model=64, 2 heads, 2 enc + 1 dec layers, dim_ff=256)
- Token vocabulary: 1194 codes in `mae_registry.json` (4 active token types)
- Token types (from `enabled_token_types` in mae_config.json):
  - 0=lab_history, 1=panel_sibling, 2=unrelated_lab, 3=administrative
- Coverage: 64 labs in `lab_columns`, 61 calibrated (`calibrated_labs` in registry)
- `selected_threshold`: 0.85 (stored in registry, applied at inference)
- Artifacts in `models/MAE/`:
  - `mae_model.pt` - full state_dict [1194, 64] code embedding
  - `mae_registry.json` - code_to_id (1194), normalizers, sigma_by_lab, calibrated_labs, thresholds
  - `mae_config.json` - training hyperparameters
  - `pkl/mae_sigmas.pkl` - per-lab residual sigma (64 labs)
  - `pkl/mae_calibrators.pkl` - isotonic calibrators (61 labs)
  - `mae_pipeline_results.csv` - metrics at threshold=0.85 (62 labs: SMAPE, ROC_AUC, MAE, Saved%)
  - `mae_feature_registry.csv` - feature token definitions
- Feature importances: cross-attention weights from last decoder layer (proxy, not causal)
- Frontend: fully wired - dual-model prediction (NGBoost default, MAE toggle), Performance tab active
- Dual-model API: `POST /api/predict` with `models: ["ngboost","mae"]` returns both results
- Lab coverage: `GET /api/lab_model_coverage` returns per-lab `{ngboost: bool, mae: bool}`

## Sensitivity section — input behavior (`frontend/js/sensitivity.js`)
Every control accepts **both drag and typed entry**, kept in sync:
- Each feature row has a slider **plus an editable number field** (`.sens-slider-num`).
  Typing drives the slider and re-predicts; the slider drives the field. The
  `Skip threshold` control works the same (slider + `#sensThrVal` number field).
- **Inputs are clamped to the trained range** — never above/below the lab's
  `clip_bounds` (slider `min`/`max`, also enforced in JS before the value reaches the
  model); the threshold is clamped to `0.50–0.99`. We never predict outside the range
  the model was calibrated on. This is a hard requirement, not cosmetic.
- **"unusual for this lab" flag** (warn-only) appears when a value is >2× the lab's
  `spread` (RMSE from `lab_norms`) away from its `typical` (mean). It does NOT block —
  typical/spread come from `lab_norms`, never invented.
- **Reset to baseline** button (`#btnSensReset`) restores all inputs to the patient's
  original stored values, then re-predicts.

## Known Patterns
- Lab key = `<Lab>_<scope>` where scope ∈ {`all`, `M`, `F`}. Sex-specific labs:
  CPK, HGB, HCT, RBC, HDL, Ferritin, Methemoglobin.
- Every model has a paired `_calibrator.pkl`.
- Adapter pattern: each model family implements one common `predict()` interface so the
  frontend and Monte Carlo stay model-agnostic, enabling model selection + comparison.
