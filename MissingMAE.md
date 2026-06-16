# MissingMAE.md - פערים בין NGBoost ל-MAE

> מסמך זה מפרט **דבר דבר** מה קיים עבור NGBoost ולא קיים עבור MAE,
> מה צריך לייצר, ולאיפה הוא משפיע בממשק המשתמש.
>
> נוצר: 2026-06-15 | סטטוס: Active build

---

## 1. קובץ Threshold Sweep (מדדים לפי ערך סף)

### NGBoost - מה קיים
**קובץ:** `models/ngboost/pipeline_results_thresholds.csv`
- 330 שורות = 59 בדיקות x 5 ערכי סף: **0.5, 0.625, 0.75, 0.875, 0.99**
- עמודות לכל נקודה: `Saved, FN, Saved%, FNR%, ECE_wf, MCE_wf, AUC_wf, BSS%_wf, Brier_wf, Instability_%`
- ה-UI מציג: גרף "Threshold Sensitivity" (Saved% vs FNR%) בעמוד Performance per-lab

### MAE - מה חסר
**קובץ:** `models/MAE/mae_pipeline_results_enriched.csv`
- רק **נקודה אחת** לכל בדיקה: Threshold = 0.9
- 62 שורות בלבד (חסרות: PT, PTT)
- **השפעה:** גרף ה-Threshold Sensitivity בעמוד Performance לא מוצג עבור MAE (מחזיר `[]`)

### מה צריך לייצר
קובץ `models/MAE/mae_pipeline_results_thresholds.csv` עם אותה מבנה:
- ערכי סף מומלצים: 0.5, 0.625, 0.75, 0.85, 0.875, 0.99
- **הנתונים כבר קיימים!** ב-`models/MAE/mae_predictions.csv` (130,959 שורות עם: Lab, Threshold, mu, sigma, prev, actual, p_stable)
- יש לחשב לכל lab x threshold את: Saved, FN, Saved%, FNR%, ECE, MCE, ROC_AUC, BSS_%

---

## 2. קבצי PNG - גרפי Calibration לכל בדיקה

### NGBoost - מה קיים
**תיקייה:** `calibration/ngboost/`
- 67 קבצי PNG - אחד לכל בדיקה (כולל 3 פאנלים + global + summary)
- שם הקובץ: `{Lab}_calibration.png` (או `{Lab}_{Sex}_calibration.png`)
- ה-UI מציג: "Calibration Plot" בעמוד Performance per-lab

### MAE - מה חסר
- **אין תיקייה** `calibration/mae/`
- **אין אפילו PNG אחד** לאף בדיקה
- **השפעה:** `calibration_url = None` לכל בדיקות ה-MAE → אין גרף calibration בממשק

### מה קיים כחלופה
`models/MAE/calibration_by_lab.csv` - ערכי ECE ו-MCE בלבד (ספרות, לא גרף)

### מה צריך לייצר
תיקייה `calibration/mae/` עם PNG לכל 64 בדיקות.
ניתן לחשב מ-`mae_predictions.csv` (שיש בו p_stable ו-actual לכל תצפית).

---

## 3. קבצי PNG - סיכום כלל-מודל (Overview Charts)

### NGBoost - מה קיים
**תיקייה:** `models/ngboost/png/`
- `summary_ece.png` - ECE לפי בדיקה
- `summary_roc_auc.png` - ROC_AUC לפי בדיקה
- `summary_efficiency_safety.png` - Saved% vs FNR%
- `summary_instability_vs_metrics.png` - Instability vs metrics
- `summary_threshold_sweep.png` - Threshold sweep overview
- ה-UI מציג אותם בעמוד Performance → NGBoost leaderboard

### MAE - מה חסר
- **אין תיקייה** `models/MAE/png/`
- **אין אפילו PNG אחד** סיכום
- **השפעה:** לוח ה-leaderboard של MAE בעמוד Performance חסר ויזואליזציות

### מה צריך לייצר
תיקייה `models/MAE/png/` עם:
- `summary_roc_auc.png` - ROC_AUC לכל 62 בדיקות
- `summary_efficiency_safety.png` - Saved% vs FNR%
- `summary_smape_nrmse.png` - ביצועי ניבוי ערך
ניתן לחשב מ-`mae_pipeline_results_enriched.csv`.

---

## 4. מטריצת קורלציות בין-בדיקות

### NGBoost - מה קיים
- `models/ngboost/global_lab_correlation.csv` - מטריצת 66x66
- `models/ngboost/pkl/global_lab_correlation.pkl` - גרסת pickle
- ה-API מחזיר: top 8 בדיקות הכי מתואמות לכל בדיקה
- ה-UI מציג: "Top Correlated Labs" בעמוד Performance per-lab

### MAE - מה חסר
- **אין מטריצת קורלציה נפרדת ל-MAE**
- **השפעה:** `correlations = []` לכל בדיקות MAE → אין גרף קורלציות

### הערה
MAE **משתמש** במטריצת הקורלציה של NGBoost בפנים (דרך `clip` ו-`ngb_entry`) אבל לא מחשב קורלציות משלו.
ניתן לחשב קורלציות MAE מ-`mae_validation_predictions.csv` (196,672 שורות עם mu לכל lab).

---

## 5. מדדי ביצועים חסרים לבדיקות ספציפיות

### PT ו-PTT
- נמצאות ב-`lab_columns` של MAE (64 בדיקות) אבל **חסרות** מ-`mae_pipeline_results_enriched.csv`
- **השפעה:** אין ביצועים להציג → ה-API מחזיר `None` לכל המדדים
- **מה צריך:** להוסיף שורות עבור PT ו-PTT ל-CSV (אם יש נתונים)

### PT, PTT, Specific_gravity - לא מכוילות
- **אין calibrator** ב-`pkl/mae_calibrators.pkl` עבורן
- `calibrated_labs` לא כולל אותן
- **השפעה:** P(stable) מחזיר את הערך הגולמי ללא כיול → פחות מהימן
- **מה צריך:** לאמן calibrator עבור 3 בדיקות אלו

---

## 6. מבנה Registry לכל בדיקה (per-lab metadata)

### NGBoost - מה קיים
`models/ngboost/pkl/registry.json` - per-lab dict עם:
| שדה | תיאור | שימוש ב-UI |
|-----|--------|-----------|
| `feature_cols` | רשימת פיצ'רים קבועה לכל בדיקה | סליידרים בסנסיטיביטי |
| `stability_threshold` | סף יציבות לבדיקה | חישוב P(stable) |
| `confidence_cutoff` | סף ביטחון | confidence badge |
| `y_transform` | `log1p` או `none` | המרה הפוכה של ניבוי |
| `quant_step` | עיגול לפי שלב הבדיקה | הצגת הערך |
| `profile_family` | `CBC`, `BG_chem`, `BG_gas`, `null` | פאנל Monte-Carlo |
| `mae_te`, `rmse_te`, ... | מדדי ביצוע | reliability label |
| `n_test` | מספר תצפיות בtest | "n test" בממשק |
| `mean_val_te` | ממוצע ערכי הבדיקה | context בממשק |

### MAE - מה חסר
`models/MAE/mae_registry.json` הוא **flat global registry** - אין per-lab entries:
- `code_to_id` - מילון 1194 קודים
- `normalizers` - normalization לכל קוד
- `sigma_by_lab` - sigma לכל בדיקה
- `lab_columns` - רשימת כל 64 הבדיקות
- `calibrated_labs` - 61 בדיקות מכוילות

**חסר לחלוטין:**
- `feature_cols` per-lab → MAE מחזיר `[]` (נכון, כי MAE לא משתמש בוקטור קבוע)
- `profile_family` per-lab → MAE מחזיר `None` לכל בדיקה → **אין joint panel predictions עבור MAE**
- `stability_threshold` per-lab → MAE קורא מ-NGBoost registry (כ-fallback)
- `quant_step` per-lab → MAE קורא מ-NGBoost registry (כ-fallback)
- `y_transform` → MAE תמיד משתמש ב-`none` (sigma כבר ביחידות מקוריות)

---

## 7. מדדי ביצועים - מה קיים vs. מה חסר לכל בדיקה

| מדד | NGBoost | MAE (enriched CSV) | מצב |
|-----|---------|---------------------|-----|
| SMAPE_mean% | ✅ | ✅ | תקין |
| SMAPE_med% | ✅ | ✅ | תקין |
| NRMSE% | ✅ | ✅ | תקין |
| MAE | ✅ | ✅ | תקין |
| RMSE | ✅ | ✅ | תקין |
| ROC_AUC | ✅ | ✅ | תקין |
| ECE | ✅ | ✅ (מ-calibration_by_lab.csv) | תקין |
| MCE | ✅ | ✅ (מ-calibration_by_lab.csv) | תקין |
| BSS_% | ✅ | ✅ | תקין |
| Saved% | ✅ | ✅ | תקין |
| FNR% | ✅ | ✅ | תקין |
| Base_Stability_% | ✅ | ✅ | תקין |
| Threshold sweep (5 נקודות) | ✅ | ❌ רק נקודה אחת (0.9) | **חסר** |
| Calibration PNG | ✅ 67 קבצים | ❌ אין | **חסר** |
| Value distribution (p5/p25/median/p75/p95) | ✅ | ❌ | **חסר** |
| Lab correlation matrix | ✅ 66x66 | ❌ | **חסר** |
| Summary overview PNGs | ✅ 5 קבצים | ❌ | **חסר** |
| Per-lab registry entry | ✅ | ❌ (flat global) | שונה במהות |

---

## 8. Joint Panel Prediction (Monte Carlo)

### NGBoost - מה קיים
- כל בדיקה יודעת ל-`profile_family` שלה (`CBC`, `BG_chem`, etc.)
- `/api/predict_profile` מריץ Monte Carlo משותף על מטריצת הקורלציה
- ה-UI מציג: tubes עם joint P(all stable) בעמוד Patient

### MAE - מה חסר
- `profile_family = None` לכל בדיקות MAE
- Monte Carlo ל-MAE לא ממומש
- **השפעה:** כשהרופא בוחר MAE, ה-tubes מחשבות NGBoost Monte Carlo (לא MAE)
- **מה צריך:** להגדיר `profile_family` per-lab ב-mae_registry.json, ולממש MAE-based Monte Carlo (או לאפשר שימוש במטריצת NGBoost)

---

## 9. קבצי נתוני אימות שקיימים ב-MAE אך לא מנוצלים

| קובץ | תוכן | שורות | פוטנציאל |
|------|--------|--------|-----------|
| `mae_predictions.csv` | Lab, Threshold, mu, sigma, prev, actual, p_stable | 130,959 | threshold sweep, calibration PNGs |
| `mae_validation_predictions.csv` | Lab, mu, actual, prev | 196,672 | distribution, correlations, more calibration |
| `mae_feature_registry.csv` | 1129 token definitions עם token_type, source_table, observed_rows | 1,129 | הסבר features בממשק |

---

## סיכום - עדיפויות

### גבוהה (משפיע על ממשק קיים)
1. **mae_pipeline_results_thresholds.csv** - threshold sweep ל-6 ערכי סף
   - ניתן לחשב מ-`mae_predictions.csv` → script python
   - משפיע: גרף Threshold Sensitivity בעמוד Performance per-lab

2. **calibration PNGs** (`calibration/mae/{Lab}.png`)
   - ניתן לחשב מ-`mae_predictions.csv` (p_stable vs actual)
   - משפיע: Calibration plot בעמוד Performance per-lab

3. **Value distribution** (p5/p25/median/p75/p95 per lab)
   - ניתן לחשב מ-`mae_validation_predictions.csv`
   - משפיע: Distribution chart בעמוד Performance per-lab

### בינונית
4. **Summary PNGs** (`models/MAE/png/`)
   - ניתן לחשב מ-`mae_pipeline_results_enriched.csv`
   - משפיע: Overview visuals בעמוד Performance → MAE

5. **Calibrators לPT, PTT, Specific_gravity**
   - משפיע: מהימנות P(stable) ל-3 בדיקות ספציפיות

### נמוכה (שינוי ב-registry)
6. **profile_family per-lab ב-mae_registry.json**
   - משפיע: Joint panel Monte Carlo ל-MAE

7. **Lab correlation matrix ל-MAE**
   - ניתן לחשב מ-`mae_validation_predictions.csv`
   - משפיע: "Top Correlated Labs" בממשק MAE performance

---

## Script מומלץ ליצירת הקבצים החסרים

```bash
# ליצור:
# 1. mae_pipeline_results_thresholds.csv  (מ-mae_predictions.csv)
# 2. calibration PNGs                     (מ-mae_predictions.csv)
# 3. value distributions                  (מ-mae_validation_predictions.csv)
# 4. summary PNGs                         (מ-mae_pipeline_results_enriched.csv)
python scripts/build_mae_artifacts.py
```

כל הנתונים הגולמיים כבר קיימים - זה עניין של ריצת script אחד.
