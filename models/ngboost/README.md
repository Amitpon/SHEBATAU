# Lab Redundancy Prediction Pipeline
**Shiba Medical Center - Tel Aviv University - Year 3 Project**

Probabilistic model that recommends cancelling repeat lab test orders when the result is predicted to be clinically stable. Built on NGBoost (Normal distribution output) + Isotonic Calibration. Deployed as a decision-support tool - the physician always makes the final call.

---

## Quick Start

1. Place `merged_all.csv` in the project root.
2. Open `lab.ipynb`.
3. Run all cells top-to-bottom **in order** (order matters - see [Dependency Chain](#dependency-chain)).
4. Set `RETRAIN = True` in Cell 18 for first run; `False` to reload saved models.
5. Results land in `models/`.

---

## Core Concept

For each repeat lab order the model answers:

```
P(stable) = Phi(prev1 + delta,  mu, sigma)
          - Phi(prev1 - delta,  mu, sigma)
```

Where:
- `prev1` - last measured value (updated dynamically; never the static test-set value)
- `mu, sigma` - NGBoost prediction: full Normal distribution, not a point estimate
- `delta` - per-lab clinical stability threshold (defined in `CLINICAL_THRESHOLDS`)
- `Phi` - Normal CDF

**Decision rule:** `P(stable) >= 0.50` - recommend CANCEL.

`P(stable)` is calibrated with Isotonic Regression (fit on OOF pooled Val predictions from K expanding folds) before use.

**Key metrics:**
- `Saved%` = cancelled / total repeat orders
- `FNR%` = FN / (FN + TP) = cancelled-and-unstable / **all actually unstable** (the clinical safety metric; lower is safer)

---

## Data Requirements

**Input file:** `merged_all.csv` - one row per (patient x date x lab panel).

**Required columns:**

| Column | Description |
|--------|-------------|
| `id` | Patient identifier |
| `admissionnumber` | Admission identifier |
| `date` | Test date (YYYY-MM-DD) |
| `_sex` | `M` / `F` |
| `admission_date` | Date of hospital admission |
| One column per lab | Numeric result (NaN = not ordered that day) |

**Context columns** (optional but used when present):

| Group | Columns | Notes |
|-------|---------|-------|
| Vitals | `sbp`, `dbp`, `pulse`, `storation` | Same-day measurements - safe to use as-is; clip bounds from MIMIC-III 2016 |
| Background diagnoses | `bg_chapter_*`, `bg_num_background_diagnoses` | Pre-existing - constant per admission, safe |
| Drug counts | `num_unique_drugs`, `num_administrations`, `num_high_risk_drugs`, `num_iv_solutions` | **Shifted 1 day** - may reflect today's lab result |
| Drug categories | `atc1_*` (24 cols) | **Shifted 1 day** |
| ICD chapters | `chapter_*` (15 cols) | **Shifted 1 day** - 99% appear after day 1 |
| Diagnosis timing | `timing_*` (5 cols) | **Shifted 1 day** |
| Imaging type | `img_*` (11 cols) | **Shifted 1 day** - 66% appear after day 1 |
| Echo / ECG | `echo_done`, `ecg_done` | **Shifted 1 day** |
| Consilium | `consilium_last_24h`, `urgent_consilium` | **Shifted 1 day** |
| Diagnosis count | `daily_diagnosis_count`, `total_imaging_count` | **Shifted 1 day** |
| Test counters | `test_number_overall`, `test_number_in_admission` | **Shifted 1 day** - include today's panel |

> **Why shift?** Columns that change during admission may reflect clinician response to lab results. Using today's value would teach the model reverse causality. Shifting to yesterday's value enforces temporal integrity.

---

## Pipeline Architecture

### Data Split (patient-level, not row-level)

```
All patients  ->  Train 60% | Val 20% | Test 20%
```

Patient-level split prevents any patient's visits from appearing in two sets, which would corrupt `prev1` and the chronological walk-forward simulation.

### Cell Execution Order and Purpose

| Cell | ID | Purpose |
|------|----|---------|
| 00 | md-00 | Project title and notebook map |
| 01 | md-01 | Imports explanation |
| **02** | cell-01 | **Imports + Global Constants + `CLINICAL_THRESHOLDS`** |
| 03 | md-03 | Feature engineering docs |
| **04** | cell-03 | `perform_feature_engineering()` - standalone helper |
| 05 | md-04 | Clipping docs |
| **06** | cell-04 | `fit_clip_bounds()` + `apply_clip_bounds()` + `fit_quant_steps()` + `_snap_mu()` |
| 07 | md-05 | Feature matrix docs |
| **08** | cell-05 | `prepare_features_for_model()` |
| 09 | md-06 | Feature selection docs |
| **10** | cell-06 | `select_dynamic_features()` |
| 11 | md-07 | NGBoost training docs |
| **12** | cell-07 | `train_ngboost_model()` |
| 13 | cell-oof-md | OOF calibration - explanation and fold diagram |
| **14** | cell-oof-cod | OOF calibration - constants (`OOF_K`, `OOF_BOUNDARIES_PCT`, `MIN_OOF_FOR_CALIBRATION`) + `run_oof_calibration()` reference |
| 15 | md-08 | Confusion matrix docs |
| **16** | cell-08 | `plot_global_confusion_matrix()` |
| 17 | md-09 | Pipeline docs |
| **18** | cell-09 | **Main pipeline** - `_add_features`, `simulate_iterative_journey`, `run_full_pipeline` |
| 19 | md-10 | Run settings docs |
| **20** | cell-retrain | **`RETRAIN` / `N_SAMPLE` flags** - set these before running |
| **21** | cell-10 | **Execute or load pipeline** |
| 22 | 623cfdcb | Panel analysis docs |
| **23** | e0654b4b | Panel analysis - per-lab metrics + heatmap + confusion matrix |
| 24 | md-11 | Feature importance docs |
| **25** | 5496d630 | Feature importance charts |
| 26 | md-12 | Walk-through docs |
| **27** | 30479931 | RBC + HCT clinical walk-through + TP/TN examples |
| 28 | 0c6f292b | All-labs confusion matrix docs |
| **29** | 2d614b4b | All-labs confusion matrix |
| 30 | md-14 | Calibration curves docs |
| **31** | f2fe5e36 | `plot_calibration()` function |
| **32** | 9c52fd59 | All-labs calibration curves (Reliability Diagram + ROC) |
| 33 | md-15 | Missing models docs |
| **34** | 4f45fa9b | Missing models check |
| 35 | md-15 | Final report docs |
| **36** | cell-15 | Final report + feature composition |
| 37 | md-17 | Global summary docs |
| **38** | 79b3c521 | Load results CSV |
| **39** | cae90abd | Global summary - KPIs + Figs A-E + threshold table |

---

## Dependency Chain

Each arrow is a hard dependency. Swapping two linked cells causes either a `NameError` or data leakage.

```
Cell 02  (constants + CLINICAL_THRESHOLDS)
   |
Cell 04  (perform_feature_engineering - defines prev1, target, days, first_in_adm)
   |
Cell 06  (fit_clip_bounds + fit_quant_steps - Train only)
   |
Cell 08  (prepare_features_for_model - temporal integrity, sentinel -999)
   |
Cell 10  (select_dynamic_features - dropout first, then f_regression + DecisionTree)
   |
Cell 12  (train_ngboost_model - 2000 trees, early stopping on Val+dropout)
   |
Cells 13-14  (OOF calibration: explanation + constants OOF_K / OOF_BOUNDARIES_PCT / MIN_OOF_FOR_CALIBRATION)
   |
Cell 16  (plot_global_confusion_matrix - ready to call)
   |
Cell 18  (run_full_pipeline):
   +-- _add_features():
   |     +-- shift(1) all same-day context columns (drugs, diagnoses, imaging, etc.)
   |     +-- build prev1 / target / days_since / first_in_adm per lab
   +-- fit_clip_bounds(train) -> clip_bounds.pkl
   +-- fit_quant_steps(train) -> quant_steps.pkl
   +-- apply_clip_bounds(train, val, test)
   +-- Phase A - per lab x sex:
   |     +-- prepare_features_for_model()
   |     +-- _apply_dropout(X_tr, 30%, seed=42)
   |     +-- select_dynamic_features()
   |     +-- detect log1p transform (skew > 2 and min >= 0)
   |     +-- OOF Isotonic Calibration (K=4 expanding folds, pool=Train+Val, pooled predictions -> 1 calibrator)
   |     +-- train_ngboost_model() on Train [60%] with early-stop on Val [20%]
   |     +-- simulate_iterative_journey(conf_th=0.50)   -> Saved%, FNR%
   |     +-- threshold sweep x 3 thresholds (silent)   -> ECE_wf, AUC_wf, ...
   +-- Phase B - per panel family (CBC, BG_gas, BG_chem):
   |     +-- compute_family_correlation(val)            -> R matrix
   |     +-- find_k_from_per_lab_fnr()                 -> k-FWER
   |     +-- evaluate_profile_test() with Gaussian copula (n_mc=2000)
   +-- save: pipeline_results.csv, registry.json, *.pkl, *.npy
   |
Cell 20  (set RETRAIN / N_SAMPLE)
   |
Cell 21  (run or reload pipeline)
   |
Cells 23-39  (analysis - read from models/ only, no training)
```

---

## Key Design Decisions

### Why NGBoost?

Standard regressors output a point estimate (mu only). We need `P(stable) = Phi(prev+delta, mu, sigma) - Phi(prev-delta, mu, sigma)`, which requires both mu **and** sigma. NGBoost minimises NLL of `Normal(mu, sigma)` directly, returning a full distribution per prediction. Key advantage: the decision threshold is adjustable at inference time without retraining - Jiang et al. 2024, p. 1007.

### Why Isotonic Calibration?

Raw NGBoost probabilities are systematically biased. Isotonic Regression maps raw `P(stable)` to a calibrated probability. ECE drops from ~8-10% to ~2-4% after calibration. Method from Jiang et al. 2024, p. 1010. The calibrator is fit on OOF pooled Val predictions (K=4 expanding folds) to provide approximately 4x more calibration data than the original single-holdout approach (Zadrozny & Elkan 2002, Niculescu-Mizil & Caruana 2005).

### Why shift(1) for context columns?

Same-day drug administration, imaging, or new diagnoses may be clinical responses to the lab result being predicted. Using today's value would teach the model reverse causality. Shifting to yesterday's value ensures the model only sees information that was available **before** the result was known.

### Why patient-level split?

Row-level splitting would allow different visits of the same patient to appear in Train and Test, leaking `prev1` values across the boundary and breaking the chronological walk-forward simulation.

### Why 30% dropout on Train / 20% on Val?

At deployment, ~30% of lab orders are cancelled. If `prev1` is always present during training, the model is miscalibrated for the deployment distribution. Dropout on Train simulates absent `prev1`; dropout on Val ensures early stopping also reflects that reality. Val rate is 20% because Val equals Test size (20%); same deployment distribution - higher dropout would introduce excessive NLL noise.

### Decision threshold = 0.50

The system is a decision-support tool. `P(stable) >= 0.50` means "the model thinks it is more likely stable than not." The physician adjusts from there. Three thresholds (0.50, 0.75, 0.99) are evaluated post-hoc to present a safety-efficiency trade-off curve.

### Stability thresholds (delta) - RCV-based, not 25%-of-range

For 7 core labs (WBC, HGB, PLT, Na, K, Albumin, Creatinine), delta comes from Jiang et al. 2024 Table 2 (clinician-validated). For all other labs, delta is derived from the **Reference Change Value (RCV)** formula using the Westgard/Ricos Biological Variation Database 2014:

```
RCV% = 1.96 x sqrt(2) x sqrt(CVi^2 + CVa^2)
delta = RCV% x range_midpoint
```

Where CVi = within-subject biological variation, CVa = analytical imprecision.
For blood-gas co-oximetry and state-dependent analytes (CRP, pO2, Lactate), delta is set on clinical grounds because RCV is not meaningful.

### Clinical clip bounds - no statistical formula

`clip_floor` / `clip_ceiling` in `CLINICAL_THRESHOLDS` replace the previous data-driven P0.1/P99.9 +/-75% formula. Every lab now has explicit bounds from:

1. **Jiang et al. 2024, Table 2** - 7 labs (Stanford, clinician-validated)
2. **Shah et al. 2025, Diagnostics 15(5):604** - panic values, 50 US hospitals
3. **LabPedia / clinical consensus** - lipids, bilirubin
4. **Clinical estimate** - remaining labs (pattern: low-2xrange / high+3xrange)

**Three behaviors by pipeline stage:**

| Stage | What happens to extreme-prev1 rows |
|-------|-------------------------------------|
| **Training / Validation** | Fully excluded - model never sees them (`_mark_extreme_prev1` before Winsorizing) |
| **Test simulation** | Always **TP** - physician always needs to see extreme result (never FP, never FN) |
| **Non-prev1 features** | Winsorized (capped to boundary) - rows are kept |

At inference: if `prev1` is outside `[clip_floor, clip_ceiling]` - **auto-KEEP** (model not called):
- `actual_stable_arr = False` always - always **TP** in confusion matrix
- Even if the value technically stabilized (|actual-prev1| <= delta), the physician always wants this result - never FP
- `_n_ak_u` tracks biological instability **for analytics only** (Fig F), separate from confusion matrix
- Implements Jiang et al.'s "acceptable prior result range" methodology.

---

## Output Files (`models/`)

| File | Contents |
|------|----------|
| `{key}.pkl` | Trained NGBoost model (key = `{lab}_{sex}`) |
| `{key}_calibrator.pkl` | Isotonic calibrator for that model (fit on OOF pooled predictions) |
| `clip_bounds.pkl` | Clinical bounds from `CLINICAL_THRESHOLDS` (no statistical computation) |
| `quant_steps.pkl` | Reporting grid step per lab (fit on Train) |
| `registry.json` | Metadata: feature_cols, y_transform, quant_step, conf_th |
| `pipeline_results.csv` | Per-lab metrics at threshold 0.50 |
| `pipeline_results_thresholds.csv` | Per-lab x 3 threshold sweep (0.50, 0.75, 0.99) |
| `_actual_unstable.npy` | Boolean array for global confusion matrix |
| `_pred_keep.npy` | Boolean array for global confusion matrix |
| `family_confusion.pkl` | Confusion arrays per panel family |
| `calibration_plots/{key}.png` | Reliability Diagram + ROC per lab |

---

## Lab Configuration (`CLINICAL_THRESHOLDS`)

Each entry:
```python
"HGB": {
    "low_M": 13.5, "high_M": 17.5,      # male reference range (Sheba data)
    "low_F": 12.0, "high_F": 15.5,      # female reference range (Sheba data)
    "stability_threshold": 1.0,           # delta - Jiang 2024 Table 2 (RCV=1.15 g/dL)
    "clip_floor": 7.0,                   # Jiang 2024 Table 2
    "clip_ceiling": 25.0,                # Jiang 2024 Table 2
}
```

Fields:
- `stability_threshold` - delta for P(stable) window, from Westgard RCV or Jiang 2024 (see source comment in each entry)
- `clip_floor` / `clip_ceiling` - acceptable prior-result range; values outside - auto-KEEP at inference
- `zero_valid=True` - only for `NRBC_abs`, `Baso_abs`, `Eos_abs` (count of 0 is clinically normal)

Sex-specific labs (separate M/F models): HGB, HCT, RBC, HDL, CPK, Methemoglobin, Ferritin.

---

## Data Leakage Safeguards

| Safeguard | What it prevents |
|-----------|-----------------|
| `shift(1)` on context columns | Same-day drugs/diagnoses/imaging leaking into features |
| `_mark_extreme_prev1` on raw data (pre-clip) | Excluding extreme-prev1 rows based on Winsorized (and thus ambiguous) data |
| `fit_clip_bounds` - constants from dict | No statistical formula touches Test; bounds are fixed clinical constants |
| Exclude extreme-prev1 from Train+Val | Model training on cases that are always mandatory repeat tests |
| `fit_quant_steps` on Train only | Test grid resolution leaking into mu rounding |
| `select_dynamic_features` on Train+dropout | Feature selection optimised for always-present `prev1` |
| Early stopping on Val+dropout | NGBoost optimised for unrealistic `prev1` availability |
| OOF Isotonic Calibration on pooled Val predictions | Calibrator overfit to Test (pooling K folds prevents overfit to single Val split) |
| `compute_family_correlation` on Val only | Copula R matrix reflects Test |
| All metrics computed on Test only | Optimistic reporting from Val |
| Threshold = 0.50 fixed (not searched) | Threshold selected by peeking at Test |

---

## Model Limitations

1. **No true causal inference** - the model learns statistical associations, not causal mechanisms. A high `P(stable)` does not mean the test is safe to skip in all contexts.
2. **No physician intent** - the model does not know why the physician ordered the test (routine monitoring vs. specific concern). It may recommend cancelling a test ordered for a specific clinical reason.
3. **Distribution shift** - the model is trained on a single institution's data. Performance may degrade for different patient populations, lab equipment, or clinical protocols.
4. **Cold start** - if a patient has no prior measurement in the current admission, `prev1` is missing. The model falls back to sentinel values but has reduced predictive power.
5. **Ferritin delta** - a single `stability_threshold` is used for both sexes (anchored to male range: 95 ng/mL). For female patients the true RCV is ~34 ng/mL - a future improvement.
6. **Clinical estimate clip bounds** - ~30 labs lack published panic-value consensus. Their `clip_floor`/`clip_ceiling` are derived from clinical patterns (low-2xrange / high+3xrange). These should be validated with Sheba clinical staff before deployment.

---

## OOF Calibration (Implemented)

### The Problem

Single-holdout Val (20% of data) provides too few calibration samples for many lab models. Isotonic Regression needs approximately 100+ samples to fit a reliable mapping (Niculescu-Mizil & Caruana 2005). For rare labs or sex-specific splits, the Val set often falls below this threshold, producing "(no calibrator)" warnings and uncalibrated probabilities.

### The Solution: OOF Calibration with K=4 Expanding-Window Folds

Out-of-Fold (OOF) calibration pools held-out predictions from K folds to build a larger calibration set, then fits ONE Isotonic calibrator on the pooled data (Zadrozny & Elkan 2002).

### How It Works

1. **Split Train [0-80%] into K=4 expanding windows.** Each fold uses a growing training portion and a held-out validation portion, preserving chronological order.
2. **Each fold trains NGBoost independently** with early stopping (2000 trees max, stops when Val loss plateaus for 50 rounds). Train dropout = 30%, Val dropout = 20% for early stopping - unchanged from the single-split approach.
3. **Collect clean Val predictions from each fold.** These are the OOF predictions - each Val row is predicted by a model that never saw it during training. "Clean" means no dropout applied to the Val rows used for calibration (dropout is only for early stopping).
4. **Pool OOF predictions across all K folds.** This yields approximately 4x more calibration data than the original single Val set.
5. **Fit ONE Isotonic calibrator on the pooled OOF predictions.** A single calibrator per lab model, trained on the full pooled set.
6. **Train the production model on Train [0-60%]** with early stopping on Val [60-80%]. The OOF fold models are discarded after calibration - only the production model and the pooled calibrator are saved.
7. **Test [80-100%] remains completely untouched.** The calibrator is applied to Test predictions at inference time - read-only.

### Dropout Behavior (Unchanged)

- **30% Train dropout:** `prev1` set to sentinel -999 for 30% of training rows (simulates deployment where ~30% of orders are cancelled)
- **20% Val dropout for early stopping:** Ensures NLL-based stopping reflects deployment conditions
- **Clean Val for OOF predictions:** The Val predictions pooled for calibration use actual `prev1` values (no dropout), because calibration should map model confidence to true outcome probability under best-case input

### Citations

- Zadrozny & Elkan 2002 - theoretical basis for pooling held-out predictions across folds for calibrator fitting
- Niculescu-Mizil & Caruana 2005 - evidence that Isotonic Regression overfits with small calibration sets; recommendation to use cross-validation pooling

---

## Future Work

### Time-Series K-Fold Robustness Check (K=5)

OOF calibration is implemented, but full K-Fold **evaluation** across different time windows is still planned:

```
Fold 1: Train [0-60%]   -> Val [60-80%]   -> Test [80-100%]
Fold 2: Train [20-80%]  -> Val [80-95%]   -> Test [95-100%]
Fold 3: Train [40-90%]  -> Val [90-100%]  -> Test [100%+wrap]
...
Report: mean +/- std of ECE, AUC, Saved%, FNR% across K=5 folds
```

- **Scope:** Threshold = 0.50 only (not all 3 EVAL_THRESHOLDS - those are for clinical review)
- **Goal:** Confirm metrics are stable, not artifacts of the single split
- **Cost:** ~30 hours compute
- **When:** After model passes initial validation; before clinical deployment

---

## References

See [REFERENCES.md](REFERENCES.md) for the complete bibliography with links to all papers used for stability thresholds, clip bounds, calibration methodology, and other design decisions.
