# איפה לשמור כל קובץ מודל

כל הארטיפקטים המאומנים נשמרים כאן, בתיקייה לפי משפחת מודל.

## NGBoost (כבר קיים)
```
models/ngboost/
├── registry.json                 # קונפיג + מדדי חוזק לכל בדיקה (לשמור מסונכרן!)
├── pipeline_results.csv          # ביצועים מפורטים לכל בדיקה
├── global_lab_correlation.pkl    # קורלציות בין בדיקות (ל-Monte Carlo של פאנלים)
└── pkl/
    ├── <Lab>_all.pkl             # מודל לבדיקה (למשל Glucose_all.pkl)
    ├── <Lab>_all_calibrator.pkl  # הקליבּרטור התואם
    ├── <Lab>_M.pkl / <Lab>_F.pkl # בדיקות תלויות-מגדר (HGB, HCT, RBC, CPK, HDL, Ferritin)
    ├── clip_bounds.pkl           # קבצי עזר משותפים
    ├── quant_steps.pkl
    └── family_confusion.pkl
```

## מודל חדש (למשל MAE-embedding)
1. צור תיקייה `models/MAE/` (קיימת, ריקה).
2. שים שם את קבצי ה-pkl באותו היגיון שמות.
3. הוסף `registry.json` באותו פורמט (אותם שדות: `lab`, `feature_cols`,
   `profile_family`, `stability_threshold`, `confidence_cutoff`, מדדי חוזק).
4. זהו — הוסף adapter אחד ב-`backend/models/` והכל יעבוד. אין צורך לגעת בשאר הקוד.

> חוק: לא לערוך / להזיז / לדרוס קבצים כאן ידנית — אלו ארטיפקטים מאומנים.
> מדדי החוזק שמוצגים לרופא נלקחים אך ורק מ-`registry.json` / `pipeline_results.csv`.

## מאיפה כל מסך בממשק שואב נתונים
- **Patient (חיזוי):** `pkl/<Lab>_<scope>.pkl` + `_calibrator.pkl` דרך ה-NGBoost adapter.
- **Models (הסבר מודל):** טקסט ב-`backend/methodology.py` + מאמרים מ-`Professional Articles/<family>/`
  (כל PDF שתוסיף שם מופיע אוטומטית). כרגע: `ngboost/labstabilityprediction.pdf`, `ngboost/stanford.pdf`.
- **Results / Performance:** מדדי כיול (MAE, RMSE, BSS, ECE, ROC_AUC, SMAPE, NRMSE) מ-
  `pipeline_results.csv`; feature importance מהמודל; קורלציות מ-`global_lab_correlation.pkl`;
  פאנלים מתוך `profile_family` ב-`registry.json`.
- **פאנלים (הסתברות משותפת):** Monte Carlo עם copula על `global_lab_correlation.pkl`.

> פרטיות: `data/patients/data.csv` (אם קיים) הוא נתוני מטופלים אמיתיים — לא נשמר ב-repo,
> לא נשלח. חולי דמה נוצרים רק דרך `scripts/build_demo_patients.py` וללא מזהים.
