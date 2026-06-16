# calculations.md — כל החישובים בפייפליין

> תיעוד מפורט של כל נוסחה, מאיפה נלקחה, מה כל רכיב אומר, ודוגמה מחושבת מהנתונים.

---

## תוכן עניינים

1. [סף יציבות (Δ) — שתי שיטות](#1-סף-יציבות-δ--שתי-שיטות)
2. [P(stable) — הסתברות יציבות](#2-pstable--הסתברות-יציבות)
3. [Clip Bounds — גבולות קיצוניים](#3-clip-bounds--גבולות-קיצוניים)
4. [Quantization Snapping — עיגול לרזולוציית הדיווח](#4-quantization-snapping--עיגול-לרזולוציית-הדיווח)
5. [NGBoost — אימון המודל](#5-ngboost--אימון-המודל)
6. [Dropout — סימולציית ביטולי עבר](#6-dropout--סימולציית-ביטולי-עבר)
7. [OOF Calibration — כיול Out-of-Fold](#7-oof-calibration--כיול-out-of-fold)
8. [ECE / MCE — שגיאת כיול](#8-ece--mce--שגיאת-כיול)
9. [Brier Score ו-BSS](#9-brier-score-ו-bss)
10. [ROC AUC](#10-roc-auc)
11. [Walk-Forward Simulation](#11-walk-forward-simulation)
12. [Joint P(stable) — Gaussian Copula לפאנל](#12-joint-pstable--gaussian-copula-לפאנל)
13. [זרימת הפייפליין המלאה — מקצה לקצה](#13-זרימת-הפייפליין-המלאה--מקצה-לקצה)

---

## 1. סף יציבות (Δ) — שתי שיטות

**הגדרה:** Δ הוא הסטייה המקסימלית המותרת בין תוצאה קודמת לתוצאה נוכחית כדי שהבדיקה תסווג כ"יציבה" מבחינה קלינית.

> **שים לב:** הכיתוב בתא 2 של הנוטבוק שגוי — הוא מתאר `Δ = (high−low)×0.25` כשיטה כללית. בפועל ה-pipeline משתמש בשתי שיטות שונות לחלוטין לפי הבדיקה.

---

### שיטה A — Jiang 2024 (7 בדיקות ליבה)

**מקור:** Jiang et al. (2024), Table 2 — ספי יציבות שאומתו ע"י קלינאים ב-UCSF.

7 הבדיקות: `WBC, HGB, Sodium, Potassium, Creatinine, Albumin, Glucose`

הערכים נקבעו מראש מניסיון קליני — **לא מחושבים**, אלא נלקחים ישירות מהטבלה:

| בדיקה | Δ (יחידות) | הערה |
|-------|-----------|------|
| WBC | 1.75 K/µL | RCV סטטיסטי = 2.48; Jiang שמרני יותר |
| HGB | 1.0 g/dL | RCV = 1.15 |
| Sodium | 2.5 mEq/L | RCV = 4.8; Jiang שמרני מאוד |
| Potassium | 0.5 mEq/L | RCV = 0.53 |
| Creatinine | 0.125 mg/dL | RCV = 0.187 |
| Albumin | 0.425 g/dL | RCV = 0.195 |
| Glucose | 15.0 mg/dL | — |

כשיש סתירה בין Jiang ל-RCV — **Jiang גובר** (אימות קליני עדיף על חישוב סטטיסטי טהור).

---

### שיטה B — Westgard/Ricos RCV (כל שאר הבדיקות)

**מקור:** Westgard & Ricos (2014), Reference Change Value — ערך שינוי התייחסות.

**הנוסחה:**

```
RCV% = 1.96 × √2 × √(CVi² + CVa²)

Δ = (RCV% / 100) × midpoint
```

**כל רכיב:**

| סימון | שם | משמעות |
|-------|----|---------|
| `1.96` | Z-score | רמת מובהקות 95% (שני זנבות) |
| `√2` | — | מכפיל כי השוואה בין שתי מדידות בלתי תלויות (כל אחת עם שגיאה) |
| `CVi` | Intra-individual CV | השונות הביולוגית הטבעית בתוך אותו אדם (%) |
| `CVa` | Analytical CV | שגיאת המדידה של הציוד המעבדתי (%) |
| `midpoint` | (low + high) / 2 | אמצע הטווח הנורמלי — מנרמל ל-Δ ביחידות מוחלטות |

**עקרון:** RCV הוא הסף שמעליו שינוי בין שתי מדידות אינו יכול להיות מוסבר בשגיאת מדידה ובשונות ביולוגית טבעית בלבד — כלומר, שינוי מובהק קלינית.

**דוגמה מחושבת — HCT:**

```
CVi = 3.2%  (שונות ביולוגית, מ-Ricos 2014)
CVa = 1.5%  (שגיאת מעבדה)
midpoint = (36 + 53) / 2 = 44.5 %

RCV% = 1.96 × √2 × √(3.2² + 1.5²)
     = 1.96 × 1.414 × √(10.24 + 2.25)
     = 2.772 × √12.49
     = 2.772 × 3.534
     = 9.797%

Δ = 9.797% × 44.5 / 100 = 4.36 %HCT

→ בקוד: stability_threshold = 3.0  (ה-pipeline עיגל כלפי מטה לשמרנות)
```

---

## 2. P(stable) — הסתברות יציבות

**מקור:** Jiang et al. (2024) — ארכיטקטורת NGBoost לחיזוי הסתברות יציבות מעבדתית.

### מה NGBoost מחזיר?

NGBoost (Natural Gradient Boosting) לא מחזיר נקודה אחת — הוא מחזיר **פילוג נורמלי שלם** `Normal(μ, σ)` עבור כל שורה:
- `μ` — הערך הצפוי של הבדיקה הבאה
- `σ` — אי-הוודאות סביב הצפי הזה

### נוסחת P(stable)

```
P(stable) = Φ(prev1 + Δ, μ, σ) − Φ(prev1 − Δ, μ, σ)
```

כלומר: **השטח מתחת לעקומה הנורמלית בין `prev1 − Δ` ל-`prev1 + Δ`**.

**כל רכיב:**

| סימון | משמעות |
|-------|--------|
| `Φ(x, μ, σ)` | CDF של Normal(μ, σ) — P(X ≤ x) |
| `prev1` | תוצאת הבדיקה הקודמת (הערך שכבר ידוע) |
| `Δ` | סף יציבות (מחושב בסעיף 1) |
| `μ` | הצפי של NGBoost לתוצאה הבאה |
| `σ` | סטיית התקן של NGBoost (אי-הוודאות) |

**עקרון:** אם NGBoost צופה שהתוצאה הבאה תיפול עם הסתברות גבוהה בתחום `[prev1−Δ, prev1+Δ]`, הבדיקה צפויה להיות יציבה.

### מקרה מיוחד — log1p transform

לבדיקות עם skew > 2 וכל הערכים חיוביים (CRP, Ferritin, Triglycerides):

```python
# הנתונים אומנו על log1p(y), אז גם החיזוי בסקאלת log
_lo = log1p(max(0, prev1 − Δ))
_hi = log1p(prev1 + Δ)
P(stable) = Φ(_hi, μ_log, σ_log) − Φ(_lo, μ_log, σ_log)
```

הסיבה: הפילוג בסקאלת log הוא נורמלי — ולכן הגבולות צריכים להיות בסקאלת log גם כן.

### דוגמה מחושבת — Sodium

```
prev1 = 138 mEq/L
Δ = 2.5 mEq/L  (Jiang 2024)
NGBoost חוזר: μ = 139, σ = 1.8

P(stable) = Φ(138+2.5, 139, 1.8) − Φ(138−2.5, 139, 1.8)
           = Φ(140.5, 139, 1.8) − Φ(135.5, 139, 1.8)
           = Φ(z=+0.833) − Φ(z=−1.944)
           = 0.7977 − 0.0259
           = 0.7718

P(stable) = 77.2% → ≥ 50% → המלצה: CANCEL
```

---

## 3. Clip Bounds — גבולות קיצוניים

**מקורות:**
- 7 בדיקות ליבה: Jiang et al. (2024), Table 2
- אלקטרוליטים, BG, HCT: Shah et al. (2025) — ערכי panic מ-50 בתי חולים בארה"ב
- ליפידים, בילירובין: LabPedia (ספי פתולוגיה)
- סימנים חיוניים: MIMIC-III (2016)

### לוגיקה

```python
if prev1 < clip_floor or prev1 > clip_ceiling:
    → auto-KEEP (מדלג על המודל, תמיד ממליץ לבצע)
```

**שתי מטרות:**
1. **בטיחות קלינית:** ערכים קיצוניים (פאניק) חייבים להיבדק שוב — אסור לבטל.
2. **ניקיון אימון:** שורות עם `prev1` קיצוני מוצאות מהאימון — המודל לא ילמד על מקרי קצה שבהם ממילא לא נבטל.

**דוגמה — Potassium:**
```
clip_floor = 3.0,  clip_ceiling = 6.0  (ערכי פאניק, Shah 2025)

prev1 = 6.2 mEq/L → מחוץ לגבול → auto-KEEP
prev1 = 4.1 mEq/L → תקין → עובר למודל
```

---

## 4. Quantization Snapping — עיגול לרזולוציית הדיווח

**בעיה:** מעבדות מדווחות בדיוק מוגדר — Hemoglobin ב-0.1 g/dL, Sodium ב-1 mEq/L. NGBoost מחזיר ממוצע רציף (139.37...) שאף פעם לא מופיע בפועל.

**פתרון:** לפני חישוב P(stable), מעגלים את μ לגריד הדיווח:

```
μ_snapped = round(μ / quant_step) × quant_step
```

### זיהוי `quant_step` אוטומטי מהנתונים (Train בלבד)

**שיטה ראשית — Modal Diff:**
1. לוקחים את כל הערכים הייחודיים של הבדיקה בסדר עולה
2. מחשבים הפרשים עוקבים: `[v2−v1, v3−v2, ...]`
3. לוקחים את ההפרש השכיח ביותר (mode)
4. מעגלים לקנדידט הקרוב מרשימת `[10.0, 5.0, 2.5, 2.0, 1.0, 0.5, 0.25, 0.2, 0.1, ...]`
5. מאמתים שלפחות 90% מהערכים ב-Train מתיישרים לגריד זה

**Fallback — סריקה גסה-לדקה:**
אם השיטה הראשית נכשלת (נתונים רועשים), סורקים את כל הקנדידטים ולוקחים את הקרוב המסביר 95% מהנתונים.

**דוגמה — Sodium:**
```
ערכים ייחודיים: 132, 133, 134, 135, 136, 137, ...
הפרשים: 1, 1, 1, 1, 1, ...  → mode = 1.0
קנדידט: 1.0 → 97% מהנתונים מתיישרים → quant_step = 1.0

μ_raw = 138.73 → μ_snapped = round(138.73/1.0)×1.0 = 139.0
```

---

## 5. NGBoost — אימון המודל

**מקור:** Duan et al. (2020), "NGBoost: Natural Gradient Boosting for Probabilistic Prediction." ICML.

### מה NGBoost עושה שונה מ-XGBoost?

XGBoost מחזיר נקודה אחת. NGBoost מחזיר **פילוג** — בפייפליין הזה, `Normal(μ, σ)`.

הוא מאמן שני predictor trees במקביל:
- `μ-tree`: מנבא את הממוצע
- `σ-tree`: מנבא את אי-הוודאות

### פונקציית ה-Loss

NGBoost ממזער את **Negative Log-Likelihood** של הפילוג הנורמלי:

```
NLL(y, μ, σ) = 0.5 × log(2πσ²) + (y − μ)² / (2σ²)
```

כלומר: עונש גבוה הן אם הצפי רחוק מהאמת (הגבה ראשון), והן אם הביטחון גבוה מדי (σ קטן מדי — הגבה שני).

### היפרפרמטרים

```python
n_estimators    = 2000       # מקסימום עצים
learning_rate   = 0.01      # קצב למידה (שמרני — מונע overfitting)
max_depth       = 3         # עומק כל עץ בסיס
early_stopping  = 50        # עצור אם 50 סיבובים רצופים ללא שיפור ב-Val
```

### תהליך האימון בפייפליין

```
Train (~60% מהמטופלים) + 30% dropout
    ↓
NGBoost.fit(X_train, y_train,
            X_val=X_val+20%dropout, Y_val=y_val+20%dropout,
            early_stopping_rounds=50)
    ↓
מודל סופי: n_estimators_optimal ≤ 2000
```

**למה dropout על Val גם?** כדי שה-early stopping ייעשה בתנאים שמדמים deployment — כ-20% מהפרדיקציות בפועל יהיו ללא prev1 תקין.

---

## 6. Dropout — סימולציית ביטולי עבר

**בעיה בפריסה:** אם הבדיקה הקודמת בוטלה (על סמך המלצת המודל), אין לנו `prev1`. אבל המודל אומן רק על שורות שיש בהן `prev1`.

**פתרון:** בזמן האימון, מסמנים 30% מהשורות באקראי עם ערכי sentinel:

```python
prev1 = -999.0    # "אין ערך קודם"
days_since_last = 90.0  # "עבר הרבה זמן"
```

**הנוסחה לבחירת שורות:**
```python
drop_idx = rng.choice(X.index, size=int(len(X) * 0.30), replace=False)
```

**30% ולא יותר:** הערכה שמרנית של שיעור הביטולים אחרי פריסה. אם תיכנס יותר מ-30% ביטולים בפועל — יש לחזור ולאמן.

**Sibling dropout:** לבדיקות פאנל (CBC, BMP), אם בדיקה אחת בוטלה — כל הפאנל בוטל. לכן באותן 30% שורות, גם ה-`prev1` של הבדיקות האחות מקבלות sentinel.

---

## 7. OOF Calibration — כיול Out-of-Fold

**מקורות:**
- Zadrozny & Elkan (2002), KDD — OOF calibration methodology
- Niculescu-Mizil & Caruana (2005), ICML — Isotonic Regression needs ~100 samples

### הבעיה שהכיול פותר

NGBoost מחזיר `P(stable) = 0.72`, אך בפועל רק 55% מהמקרים עם P=0.72 היו יציבים. הכיול מתקן את ההטיה הזו — ממפה P_raw → P_calibrated.

### למה OOF ולא כיול ישיר על Val?

**בעיה עם כיול ישיר:** אם נאמן NGBoost על Train עם early stopping על Val, ואז נכייל על Val — ה-NGBoost כבר ראה את Val בזמן האימון. ה-calibrator ילמד על "predictions שכבר הותאמו ל-Val", לא על predictions אמיתיות.

**פתרון OOF:** כל נקודת כיול מוחזאת על ידי מודל שלא ראה אותה.

### המבנה (K=4 folds מתרחבים על Pool=80% מהנתונים)

```
Pool [0–80% מהמטופלים]:
  Fold 0: אימון=[0%–20%]  → פרדיקציה על [20%–40%]
  Fold 1: אימון=[0%–40%]  → פרדיקציה על [40%–60%]
  Fold 2: אימון=[0%–60%]  → פרדיקציה על [60%–80%]
  Fold 3: אימון=[0%–80%]  → פרדיקציה על [80%–100%]
                                    ↓
              Pool כל OOF predictions (≈80% מה-Pool = ≈64% מכלל הנתונים)
                                    ↓
              IsotonicRegression.fit(P_raw_oof, is_stable_actual_oof)
                                    ↓
              calibrator אחד מאוחד
```

### Expanding Window — למה לא K-Fold רגיל?

K-Fold רגיל מאפשר "הסתכלות לאחור" — fold 2 מאמן על נתונים עתידיים. בנתוני time-series רפואיים, זה דליפה. Expanding window: תמיד מאמנים על העבר, מחזים על העתיד.

### תנאי מינימום

```python
MIN_OOF_FOR_CALIBRATION = 15
```

אם OOF pool < 15 שורות → `calibrator = None`. הסיבה: Isotonic Regression עם < 15 נקודות עושה overfitting חמור (Niculescu-Mizil & Caruana 2005 ממליצים על ~100).

### IsotonicRegression — איך עובד?

מתאים פונקציה **מונוטונית עולה** שממזערת MSE על זוגות `(P_raw, is_stable)`:

```
אם P_raw = 0.80 וב-OOF רק 60% היו יציבים → calibrator ימפה 0.80 → 0.60
אם P_raw = 0.40 וב-OOF 45% היו יציבים → calibrator ימפה 0.40 → 0.45
```

המונוטוניות מובטחת: `P_raw₁ < P_raw₂ ⟹ P_cal₁ ≤ P_cal₂`.

---

## 8. ECE / MCE — שגיאת כיול

**מקור:** Niculescu-Mizil & Caruana (2005), ICML.

### ECE — Expected Calibration Error

מחלקים את [0,1] ל-10 bins שווים. בכל bin: ממוצע הביטחון (predicted) לעומת שיעור ה-true positives (actual). ECE = ממוצע משוקלל של הפערים.

```
ECE = Σ_b  (|bin_b| / N) × |mean_confidence(b) − fraction_positive(b)|
```

**כל רכיב:**

| סימון | משמעות |
|-------|--------|
| `|bin_b|` | מספר הדגימות ב-bin b |
| `N` | סך כל הדגימות |
| `mean_confidence(b)` | ממוצע P(stable) בתוך bin b |
| `fraction_positive(b)` | אחוז שבאמת היו יציבים בתוך bin b |

**קוד:**
```python
for lo, hi in zip(np.linspace(0,1,11)[:-1], np.linspace(0,1,11)[1:]):
    m = (p >= lo) & (p < hi)
    if m.sum():
        err += (m.sum() / len(p)) * abs(p[m].mean() - y[m].mean())
```

**סולם ECE:**
```
< 2%   → Excellent
2–5%   → Good
5–10%  → Borderline
> 10%  → Not usable
```

### MCE — Maximum Calibration Error

שגיאת ה-bin הגרוע ביותר:

```
MCE = max_b |mean_confidence(b) − fraction_positive(b)|
```

**מתי MCE חשוב יותר?** כשיש bin ספציפי עם שגיאה גבוהה מאוד — גם אם ECE נמוך (ממוצע), MCE חושף נקודות עיוור.

### דוגמה מחושבת

```
bin [0.5, 0.6): 100 דגימות, mean_conf=0.55, fraction_pos=0.62
  תרומה ל-ECE: (100/500) × |0.55−0.62| = 0.2 × 0.07 = 0.014

bin [0.8, 0.9): 50 דגימות, mean_conf=0.85, fraction_pos=0.81
  תרומה ל-ECE: (50/500) × |0.85−0.81| = 0.1 × 0.04 = 0.004

ECE סה"כ (אחרי כל bins) = 0.031 → Excellent ✓
MCE = max(0.07, 0.04, ...) — ה-bin הגרוע
```

---

## 9. Brier Score ו-BSS

**מקור:** Brier (1950), Monthly Weather Review — פותח לחיזוי מזג אוויר, נהפך לסטנדרט להערכת מודלים הסתברותיים.

### Brier Score

```
BS = (1/N) × Σ (P_predicted − y_actual)²
```

מדד ה-MSE של ההסתברות. ערך נמוך יותר = טוב יותר.
- `BS = 0` → שלמות
- `BS = 0.25` → ממוצע המודל הנאיבי (תמיד מחזיר 0.5)

```python
_brier_model = np.mean((p_calibrated - y_actual) ** 2)
```

### Brier Skill Score (BSS)

השוואה ל-baseline נאיבי: מודל שתמיד מחזיר את שיעור ה-base rate:

```
BSS = 1 − BS_model / BS_baseline
BS_baseline = base_rate × (1 − base_rate)
```

**פירוש:**
- `BSS = 1.0` → שלמות
- `BSS = 0.0` → שווה למודל נאיבי
- `BSS < 0` → גרוע מלנחש לפי שיעור

```python
_base_rate = y_actual.mean()
_bs_base   = _base_rate * (1 - _base_rate)
BSS = 1 - _brier_model / _bs_base
```

**דוגמה:**
```
base_rate = 0.65 (65% מהבדיקות יציבות)
BS_baseline = 0.65 × 0.35 = 0.2275

BS_model = 0.14
BSS = 1 - 0.14/0.2275 = 1 - 0.615 = 0.385  → שיפור של 38.5% על הנאיבי
```

---

## 10. ROC AUC

**סטנדרט:** DeLong et al. (1988) — שמשתמשת sklearn לחישוב.

```
AUC = P(score_positive > score_negative)
```

ההסתברות שמודל נותן ציון גבוה יותר לדגימה יציבה באמת מאשר לדגימה לא יציבה.

- `AUC = 1.0` → שלמות
- `AUC = 0.5` → אקראי לחלוטין

```python
auc = roc_auc_score(y_actual, p_calibrated)
```

**תנאי מינימום:** ≥ 20 שורות ו-2 ערכים שונים ב-`y_actual`. אחרת: `NaN`.

**חשוב:** AUC מודד **דירוג** (האם high-prob > low-prob), לא כיול (האם 0.7 = 70%). מודל יכול להיות עם AUC מצוין אך ECE גרוע, ולהיפך.

---

## 11. Walk-Forward Simulation

**מטרה:** מדידת ביצועים ב"זמן אמת" — prev1 מתעדכן דינמית בהתאם להחלטות.

### עקרון: prev1 מתעדכן רק כשהבדיקה מבוצעת

```
אם המלצה = KEEP → הבדיקה מבוצעת → prev1 מתעדכן לתוצאה החדשה
אם המלצה = CANCEL → הבדיקה לא מבוצעת → prev1 נשאר ערכו הקודם
```

**למה זה חשוב?** בסימולציה פשוטה (non-walk-forward), prev1 תמיד ידוע. אבל בפועל — אם ביטלנו 3 בדיקות ברצף, prev1 הוא הערך מלפני 3 ימים. Walk-forward מדמה זאת.

### הסדר

```
לכל (מטופל, אשפוז), לפי תאריך כרונולוגי:
  1. האם prev1 קיצוני? → auto-KEEP (תמיד TP, לא נכנס ל-Confusion Matrix)
  2. חישוב P(stable) עם prev1 הנוכחי
  3. כיול (אם calibrator קיים)
  4. החלטה: ≥0.50 → CANCEL, <0.50 → KEEP
  5. אם KEEP → בדיקה מבוצעת → prev1 = תוצאה חדשה
  6. אם CANCEL → prev1 נשאר אותו ערך
```

### מדדי תפוקה

```
Sensitivity = TP / (TP + FN)     # כמה "לא יציבים" זוהו נכון
Specificity = TN / (TN + FP)     # כמה "יציבים" זוהו נכון
SaveRate    = CANCEL / Total      # כמה בדיקות בוטלו
FNR (false negative rate) = FN / (TP + FN)  # המפתח לבטיחות
```

---

## 12. Joint P(stable) — Gaussian Copula לפאנל

**מטרה:** לבדיקות פאנל (CBC, BMP, LFT), המודל מחשב הסתברות שכל הבדיקות **יחד** יציבות — בהתחשב בקורלציה ביניהן.

**מקור:** Sklar (1959) — Copula Theory; יישום: Gaussian Copula.

### הנוסחה

```python
# צעד 1: המרה לסקאלת normal
z_i = Φ⁻¹(P_stable_i)

# צעד 2: דגימה מ-Multivariate Normal עם מטריצת קורלציה R
samples ~ MVN(0, R)  [n_mc = 2000 דגימות]

# צעד 3: ספירת דגימות שכל הרכיבים "יציבים"
P(all stable) = #{samples | כל i: samples[i] ≤ z_i} / n_mc
```

**מה R?** מטריצת קורלציה בין הבדיקות — מחושבת על Val בלבד. לדוגמה: `corr(HGB, HCT) ≈ 0.95`.

**Fallback:** אם החישוב נכשל (singular matrix), משתמש במכפלה פשוטה:

```
P(all stable) = Π P_stable_i
```

**למה Copula ולא מכפלה?** מכפלה מניחה עצמאות. HGB ו-HCT מתנהגים ביחד — אם HGB יציב, סביר ש-HCT גם יציב. מכפלה תעריך חסר.

---

## 13. זרימת הפייפליין המלאה — מקצה לקצה

```
נתונים גולמיים (SHEBA)
         │
         ▼
[1] Feature Engineering
    - prev1_{lab}    ← shift(1) בתוך אותו אשפוז בלבד
    - target_{lab}   ← הערך הנוכחי (מה שנחזה)
    - days_since_last_{lab}
    - עמודות הקשר ← drugs, diagnoses, imaging (shift(1) כדי למנוע דליפה!)
    - בדיקה ראשונה בכל אשפוז: prev1 = NaN → מסוננת
         │
         ▼
[2] פיצול נתונים (Patient-Level, כרונולוגי)
    ┌─────────────────────────────────────────────────────┐
    │  Train [0–60%]  │  Val [60–80%]  │  Test [80–100%] │
    └─────────────────────────────────────────────────────┘
    Pool = Train + Val = [0–80%]
    Test = [80–100%] ← עיוור לחלוטין עד הסוף
         │
         ▼
[3] fit_clip_bounds (קבועים מספרות — לא מהנתונים!)
    fit_quant_steps (Train בלבד)
    apply_clip_bounds לכולם (Train / Val / Test)
         │
         ▼
[4] Extreme prev1 → מוסרים מ-Train/Val
    (ערכים מחוץ ל-clip_bounds ב-prev1 → לא מאמנים עליהם)
         │
         ▼
[5] select_dynamic_features
    - f_regression על Train (שורות נקיות בלבד, ≥10)
    - DecisionTree על Train+dropout
    - איחוד הרשימות → features קבועות לכל Model/Val/Test
         │
         ▼
[6] OOF Calibration (Pool בלבד, K=4 folds)
    לכל fold:
      - אימון NGBoost זמני על Train_fold + dropout
      - פרדיקציה על Val_fold
    Pool כל OOF predictions
    Fit IsotonicRegression (אם ≥15 predictions)
    → calibrator
         │
         ▼
[7] train_ngboost_model (המודל הסופי)
    - X: Train + 30% dropout
    - early_stopping: Val + 20% dropout
    - log1p transform אם skew > 2
    → model + n_estimators_optimal
         │
         ▼
[8] Test Evaluation (20% האחרונים — פעם אחת בלבד)
    Walk-Forward Simulation:
      - prev1 דינמי
      - auto-KEEP לערכים קיצוניים
      - P(stable) → calibrator → החלטה
    מדדים: ECE, MCE, BSS, Brier, AUC, Sensitivity, Specificity, SaveRate
         │
         ▼
[9] Profile (פאנל) — Phase B
    Joint P(stable) עם Gaussian Copula + מטריצת קורלציה מ-Val
```

### גבולות דליפה — מי למד ממה

| רכיב | למד על | הוחל על |
|------|--------|---------|
| clip_bounds | קבועים מספרות (לא נתונים) | Train / Val / Test |
| quant_steps | Train בלבד | בחישוב P(stable) בכל סט |
| features | Train+dropout | Val / Test (אותן עמודות) |
| NGBoost weights | Train+dropout | early-stop על Val+dropout |
| calibrator | OOF Val predictions | Test בלבד |
| R (קורלציה לפאנל) | Val בלבד | חישוב Joint P ב-Test |
| סף 0.50 | **לא נלמד** — קבוע | כל ההחלטות |
| מדדי ביצוע | Test בלבד | לא הוחל בשום מקום |

**הכלל הזהב:** Test הוא עיוור. שום דבר לא נלמד ממנו.

---

## מקורות

| נוסחה / שיטה | מקור |
|---|---|
| Stability threshold (7 labs) | Jiang et al. (2024), Table 2 |
| RCV formula | Westgard & Ricos (2014) |
| Clip bounds (panic values) | Shah et al. (2025), 50 US hospitals |
| Clip bounds (vitals) | MIMIC-III (2016) |
| NGBoost | Duan et al. (2020), ICML |
| OOF Calibration | Zadrozny & Elkan (2002), KDD |
| Isotonic Regression min samples | Niculescu-Mizil & Caruana (2005), ICML |
| Brier Score | Brier (1950), Monthly Weather Review |
| ECE / MCE | Niculescu-Mizil & Caruana (2005), ICML |
| ROC AUC | DeLong et al. (1988) |
| Gaussian Copula | Sklar (1959) |
