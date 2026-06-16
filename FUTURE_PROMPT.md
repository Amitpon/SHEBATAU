# Future Self-Prompt — Sheba CDSS (post-compact)

## Project
Clinical Decision Support System for Sheba Medical Center.
Root: `c:\Users\amit\Desktop\אתרים\שיבא אתר\שיבא (1)\`
Launch: `run.bat` → uvicorn on :8000. Python at `C:\Users\amit\AppData\Local\Programs\Python\Python311\python.exe`
No git repo yet (user hasn't asked for init).

## Architecture
- **Backend:** `backend/main.py` (FastAPI, all routes + static serving)
- **Frontend:** `frontend/` (static HTML/CSS/vanilla JS, no build step)
- **ML artifacts:** `models/ngboost/` and `models/MAE/` — NEVER edit these files
- **Registry:** `models/ngboost/pkl/registry.json` (NOT `models/ngboost/registry.json`)
- **Key backend files:** `registry.py`, `predict.py`, `montecarlo.py`, `methodology.py`, `schemas.py`
- **Key frontend JS:** `app.js`, `patient.js`, `performance.js`, `sensitivity.js`, `models.js`, `charts.js`

## Data facts (verified 2026-06-15)
- NGBoost: 48 labs with n_test >= 100 (selectable), 11 labs excluded (n < 100)
- MAE: 52 labs with n_test >= 100, 10 labs excluded (n < 100)
- Both models: 48 labs
- MAE-only (no NGBoost): Bilirubin_neonatal, Lactate, TSH, pH
- No model (neither >= 100): Iron, Ferritin, Folate, HDL, LDL, Transferrin, Triglycerides,
  Vitamin_B12, Reticulo_abs, HbA1c_pct, PT, PTT, Urobilinogen, Specific_gravity (14 labs)
- The 100-record gate is enforced by `NGB_MIN_N_TEST=100` in `registry.py` and
  `MAE_MIN_N_TEST=100` in `backend/models/mae_adapter.py`

## What was completed (2026-06-15 session)

### Already done — DO NOT redo
1. **n<100 filtering everywhere** - backend gate is in place. `/api/labs` returns only
   selectable labs (no Iron etc). Patient screen, sensitivity, performance all correct.
2. **Score bands unified** - `SCORING_CONFIG["bands"]` in `base.py`, `modelQuality()` in `app.js`,
   `_sensScoreColor()` in `sensitivity.js` all use: >=90 excellent, >=75 very good, >=60 reasonable, <60 poor.
3. **Performance "No model" tab** - replaced "Limited data" tab. Fetches `/api/lab_universe`,
   shows 3 sections: insufficient data / one method only / not modelled by design.
4. **Performance leaderboard** - added model count summary (NGBoost: 48 | MAE: 52 | Both: 48)
   and MAE-only section below the table when viewing NGBoost scope.
5. **Methodology rewrite** - `backend/methodology.py` now has accurate NGBoost description
   (Jiang et al. 2024, RCV thresholds, OOF isotonic regression, walk-forward simulation)
   and MAE description (masking, CV-weighted sampling, per-lab sigma, isotonic calibration).
6. **Clinical motivation banner** - added above model cards in `models.js` / `styles.css`:
   "Liang et al. (2023) - 15.4% reduction in unnecessary CBC orders without compromising patient safety"

## Key API endpoints
- `GET /api/labs` - only labs with >=100 records in at least one model
- `GET /api/lab_universe` - full classification: no_model_data / mae_only / ngboost_only / excluded_groups
- `GET /api/lab_model_coverage` - per-lab {ngboost: bool, mae: bool}
- `GET /api/performance?model=ngboost|mae` - leaderboard data (already filters n<100)
- `GET /api/methodology` - model descriptions (source: `backend/methodology.py`)
- `POST /api/predict` - single lab prediction
- `POST /api/predict_profile` - joint panel Monte Carlo

## Score bands (everywhere, single source of truth)
```
>=90: excellent  #15803d (green)
>=75: very good  #65a30d (lime)
>=60: reasonable #d97706 (amber)
< 60: poor       #dc2626 (red)
```
Backend: `SCORING_CONFIG["bands"]` in `backend/models/base.py`
Frontend: `modelQuality()` in `frontend/js/app.js` — all other score color functions delegate to this

## Stop rules (from CLAUDE.md)
- NEVER invent accuracy numbers - read from registry.json / pipeline_results.csv
- NEVER edit files under `models/` (trained artifacts)
- NEVER hardcode a lab list - read from registry
- NEVER commit without user asking (no git repo yet)
- NEVER install packages without listing and asking first
- Hyphens in user-facing text, never em-dash

## What is NOT yet done (potential next tasks)
- Visual verification of new UI elements (no Playwright browser available)
- NGBoost `value_level`/`decision_level` still uses 3 levels (high/moderate/low) internally
  in `base.py _level()` - this affects text descriptions only, NOT the visual score display
- References section in Models tab is commented out (`refsHtml` assignment is disabled in models.js line ~89)
- Sensitivity section: _sensScoreColor was fixed but sensitivity tab lab selector
  only shows labs from /api/labs (correct - no Iron etc)
