# References - Lab Redundancy Prediction Pipeline

Complete bibliography for all design decisions. Each entry states what it contributed to the pipeline.

---

## Core Methodology Papers

### 1. Jiang et al. 2024 - Primary Technical Reference
**Title:** Probabilistic Prediction of Laboratory Test Information Yield  
**Authors:** Jiang, Traber, Ananthakrishnan et al. (Stanford / Mass General)  
**Journal:** JAMA Internal Medicine (formerly Annals Internal Medicine Suppl.), 2024  
**PMC:** https://pmc.ncbi.nlm.nih.gov/articles/PMC10785903/

**Used for:**
- Core model architecture: NGBoost -> Normal(mu, sigma) -> P(stable) = Phi(prev+delta) - Phi(prev-delta)
- Stability threshold formula: delta = 25% of reference range width (used for the 7 labs below)
- Decision threshold: 0.50 (model recommends cancel when P(stable) >= 0.50)
- Isotonic Calibration choice (now applied via OOF pooling - see Zadrozny & Elkan 2002)
- Patient-level train/val/test split
- **Table 2 - Acceptable Prior Result Range + Stability Threshold for 7 labs:**

| Lab | stability_threshold | clip_floor | clip_ceiling |
|-----|:---:|:---:|:---:|
| WBC | 1.75 K/uL | 1.0 | 20.0 |
| HGB | 1.0 g/dL | 7.0 | 25.0 |
| PLT | 62.5 K/uL | 50.0 | 1000.0 |
| Sodium | 2.5 mEq/L | 120.0 | 155.0 |
| Potassium | 0.5 mEq/L | 3.0 | 6.0 |
| Albumin | 0.425 g/dL | 2.0 | 7.0 |
| Creatinine | 0.125 mg/dL | 0.1 | 3.0 |

- "Acceptable Prior Result Range" methodology: tests where prev1 is outside this range are excluded from training; at inference they receive auto-KEEP regardless of model output.
- NGBoost parameters: n_estimators=500, learning_rate=0.01, max_depth=3 (base learner)

---

### 2. Liang et al. 2023 (Stanford) - SmartAlert RCT
**Title:** Effect of Machine Learning-Based Decision Support on Unnecessary Laboratory Test Orders  
**Journal:** JAMA Internal Medicine, 2023  
**File:** `stanford.pdf`

**Used for:**
- Problem motivation: 15.4% reduction in CBC testing in RCT with no adverse outcomes
- Decision-support philosophy: physician always makes the final call; model is a recommendation tool
- Stability definition: predicting "stable" (no change from prev1) is clinically more useful than predicting "normal" (within reference range) - p. 7 User Co-Design
- Confirmed 20-30% of repeat inpatient tests are stable - supports Saved% target

---

## Stability Threshold (delta) - Biological Variation

### 3. Westgard/Ricos Biological Variation Database 2014
**Source:** https://www.westgard.com/biodatabase1.htm  
**Also:** 2006/2010 updates at https://www.westgard.com/biodatabase-2010-update.htm

**Used for:**
- CVi (within-subject biological variation %) for all labs except blood-gas co-oximetry
- Reference Change Value formula applied in this pipeline:
  ```
  RCV% = 1.96 x sqrt(2) x sqrt(CVi^2 + CVa^2)
  delta = RCV% x range_midpoint / 100
  ```
  where CVa (desirable analytical imprecision) = 0.5 x CVi unless better instrument data available
- Labs updated from 25%-of-range to RCV-based delta:
  Neutro_abs, Lympho_abs, Mono_abs, Eos_abs, Baso_abs, HCT, RBC, MCV, RDW, MPV,
  Chloride, Calcium, Magnesium, Phosphorus, Urea, Uric_acid, Creatinine (confirmed),
  ALT, AST, GGT, Alkaline_Phosphatase, Bilirubin_total, Bilirubin_direct, LDH, Amylase,
  Glucose, PTT, Cholesterol, LDL, HDL, Triglycerides, Iron, Transferrin, Ferritin,
  Vitamin_B12, HbA1c_pct, Lactate (CVi noted; clinical delta used), TSH, Calcium_ionized, pCO2

---

### 4. Loh et al. 2021 - Iron Panel Biological Variation
**Title:** Biological Variation of Transferrin, Ferritin, Folate, Vitamin B12  
**PMID:** 34542961  
**Source:** https://pubmed.ncbi.nlm.nih.gov/34542961/

**Used for:**
- Measured CVa (analytical imprecision) for Transferrin (0.6%), Ferritin (2.3%), Folate (4.7%), Vitamin B12 (6.1%)
- These were used instead of the desirable CVa=0.5xCVi from Westgard

---

### 5. Weykamp 2023 - HbA1c Analytical Performance
**Title:** EQAS data for HbA1c analytical imprecision  
**Source:** PMC systematic review https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10395823/

**Used for:**
- CVa approximately 2.0% for HbA1c (modern HPLC methods), used in RCV calculation

---

## Clip Bounds - Critical / Panic Values

### 6. Shah et al. 2025 - Primary Clip Bounds Reference
**Title:** Visualization of Critical Limits and Critical Values Facilitates Interpretation  
**Journal:** Diagnostics 15(5):604, 2025  
**PMC:** https://pmc.ncbi.nlm.nih.gov/articles/PMC11899349/  
**DOI:** https://www.mdpi.com/2075-4418/15/5/604

**Used for:**
- Median panic values (clip bounds) from 50 US medical centers for:
  Calcium (6.0-13.0 mg/dL), Magnesium (1.0-4.7 mg/dL), Phosphorus (1.0-9.0 mg/dL),
  Glucose (40-500 mg/dL), Chloride (70-125 mmol/L), HCT (20-60%),
  pH (7.20-7.60), pCO2 (20-70 mmHg), pO2 (clip_floor=40 mmHg only),
  Calcium_ionized (0.80-1.58 mmol/L), Lactate (ceiling=4.0 mmol/L),
  Osmolality (250-330 mOsm/kg), Neutro_abs (clip_floor=0.1 K/uL from ANC panic <0.5),
  COHb (ceiling=17%), MetHb (ceiling=5.1%), PT (panic >47 sec), Urea/BUN (panic >101),
  CPK (panic ~3100 U/L)

---

### 7. LabPedia - Lipids and Bilirubin Clip Bounds
**Source:** https://labpedia.net/critical-panic-values-https-labpedia-net-critical-panic-values-of-blood-hematology-urine-hormones-and-serology/

**Used for:**
- Lipid clip bounds: Cholesterol (50-600), LDL (20-500), HDL (10-120, panic low <25), Triglycerides (20-2000, >500 pancreatitis risk)
- Bilirubin total: clip_ceiling=25 mg/dL (panic >12 mg/dL extended for clinical range)

---

### 8. Demir et al. 2023 - Delta Check Limits (Inpatients)
**Title:** Estimation of Change Limits (delta checks) in Clinical Laboratory  
**PMC:** https://pmc.ncbi.nlm.nih.gov/articles/PMC10197470/

**Used for:**
- Context validation of stability_threshold values against known inpatient delta check ranges
- Confirmed: Sodium +/-4%, Potassium +/-19-22%, Albumin +/-17-21%, Creatinine +/-25-40%

---

## Additional Background

### 9. Fraser CG 2011 - Reference Change Value Theory
**Title:** Reference Change Values  
**Journal:** Clin Chem Lab Med 2011  
**DOI:** https://www.degruyterbrill.com/document/doi/10.1515/cclm.2011.733/html

**Used for:** Theoretical basis of the RCV formula applied in this pipeline.

### 10. EFLM Biological Variation Database
**Source:** https://www.eflm.eu/site/who-we-are/divisions/science-division/fu/tc-biological-variation-database

**Used for:** Cross-validation of Westgard/Ricos CVi values for selected labs.

### 11. Siriraj Hospital Critical Values 2018
**PMC:** https://pmc.ncbi.nlm.nih.gov/articles/PMC12148148/

**Used for:** Confirmation of Magnesium panic values (1.0-4.7 mg/dL) - agreement with Shah 2025.

### 12. MIMIC-III Critical Care Database
**Title:** MIMIC-III, a freely accessible critical care database  
**Authors:** Johnson, A. E. W., et al.  
**Journal:** Scientific Data (2016)  
**Source:** https://www.nature.com/articles/sdata201635

**Used for:**
- Vital signs clip bounds: Heart rate (pulse), Systolic BP (sbp), Diastolic BP (dbp), O2 saturation
- Reference ranges for normal/critical values in ICU populations
- Validation of acceptable prior result ranges for hemodynamic parameters

---

## Calibration Methodology

### 13. Zadrozny & Elkan 2002 - Calibration via Cross-Validation
**Title:** Transforming Classifier Scores into Accurate Multiclass Probability Estimates  
**Authors:** Zadrozny, B. & Elkan, C.  
**Conference:** KDD 2002  
**DOI:** https://doi.org/10.1145/775047.775151

**Used for:**
- Theoretical basis for OOF (Out-of-Fold) calibration: pool held-out predictions from K folds, then fit ONE calibrator on the pooled set
- Justification for preferring cross-validation calibration over single-holdout when calibration data is limited

### 14. Niculescu-Mizil & Caruana 2005 - Isotonic Regression Calibration
**Title:** Predicting Good Probabilities with Supervised Learning  
**Authors:** Niculescu-Mizil, A. & Caruana, R.  
**Conference:** ICML 2005  
**Source:** https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf

**Used for:**
- Evidence that Isotonic Regression overfits with small calibration sets (needs approximately 100+ samples per lab model)
- Recommendation to use cross-validation pooling for Isotonic calibration
- Justification for switching from single-holdout Val (20%) to OOF pooled calibration (approximately 40-50% of data)

---

## Summary - Which Paper Contributed What

| Component | Paper(s) |
|-----------|----------|
| Model architecture (NGBoost, P(stable), Isotonic Cal.) | Jiang 2024 |
| Stability thresholds - 7 core labs | Jiang 2024 Table 2 |
| Stability thresholds - all other labs | Westgard/Ricos 2014 (RCV) |
| Clip bounds - 7 core labs | Jiang 2024 Table 2 |
| Clip bounds - electrolytes, BG, HCT | Shah 2025 |
| Clip bounds - lipids, bilirubin | LabPedia |
| Clip bounds - iron panel vitamins | Loh 2021 (CVa) |
| Clip bounds - vital signs (pulse, BP, O2 sat) | MIMIC-III 2016 |
| Problem motivation & clinical validation | Liang 2023 (SmartAlert RCT) |
| auto-KEEP logic at inference | Jiang 2024 (acceptable prior result range) |
| delta validation against inpatient delta checks | Demir 2023 |
| OOF calibration methodology | Zadrozny & Elkan 2002, Niculescu-Mizil & Caruana 2005 |
