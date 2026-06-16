"""Build realistic demo patients from a raw longitudinal lab export.

Reconstructs the model feature vectors (first_in_adm_X, prev1_X, days_since_last_X,
plus vitals/raw columns) from data/patients/data.csv, picks a handful of admissions
with rich lab + panel coverage, and writes anonymised demo patients to data/patients/.

NO identifiers are copied: the source hash, real dates, MRN, department free-text are
dropped. Synthetic names/MRNs are assigned and only numeric clinical values are kept.
Run:  python scripts/build_demo_patients.py
The source data.csv can be deleted afterwards; the generated *.json are self-contained.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.registry import get_registry  # noqa: E402

OUT = ROOT / "data" / "patients"
# Raw export filename has varied (data.csv / patients.csv); use whichever is present.
DATA = next(
    (OUT / n for n in ("patients.csv", "data.csv") if (OUT / n).exists()),
    OUT / "data.csv",
)

MALE_NAMES = [
    "James Carter", "Robert Vance", "William Bradford", "David Sterling",
    "Richard Hayes", "Joseph Mercer", "Thomas Fletcher", "Christopher Finch",
    "Daniel Rhodes", "Matthew Jennings", "Anthony Briggs", "Mark Garrison",
]
FEMALE_NAMES = [
    "Mary Ellison", "Patricia Sterling", "Jennifer Hayes", "Elizabeth Mercer",
    "Linda Fletcher", "Barbara Finch", "Susan Rhodes", "Jessica Jennings",
    "Sarah Briggs", "Karen Garrison", "Nancy Whitman", "Lisa Caldwell",
]

DERIVED = re.compile(r"^(first_in_adm_|prev1_|days_since_last_)(.+)$")


def resolve_feature(name, adm, i):
    """Resolve one feature for admission rows `adm` at current event index `i`.

    Returns (value, ok). Derived features look into the history strictly before the
    current event (prev1 / days_since_last) or the whole admission so far (first_in_adm).
    Raw features are read from the current row.
    """
    m = DERIVED.match(name)
    if not m:
        if name == "days_in_admission":
            adm_start = adm["hospitaladmission"].iloc[0]
            val = (adm["date"].iloc[i] - adm_start).days
            return float(val), pd.notna(val)
        val = adm[name].iloc[i] if name in adm.columns else np.nan
        return (float(val), True) if pd.notna(val) else (np.nan, False)

    kind, lab = m.group(1), m.group(2)
    if lab not in adm.columns:
        return np.nan, False
    col = adm[lab]
    cur_date = adm["date"].iloc[i]

    if kind == "first_in_adm_":
        hist = col.iloc[: i + 1].dropna()
        return (float(hist.iloc[0]), True) if len(hist) else (np.nan, False)

    prior = col.iloc[:i].dropna()
    if not len(prior):
        return np.nan, False
    last_idx = prior.index[-1]
    if kind == "prev1_":
        return float(prior.iloc[-1]), True
    # days_since_last_
    d = (cur_date - adm["date"].loc[last_idx]).days
    return float(d), True


def features_for_lab(reg, lab, gender, adm, i):
    """All features for one lab at event i, or None if any feature is missing."""
    try:
        ent = reg.entry(lab, gender)
    except KeyError:
        return None
    out = {}
    for f in ent["feature_cols"]:
        val, ok = resolve_feature(f, adm, i)
        if not ok:
            return None
        out[f] = round(val, 4)
    return out


def build_patient(reg, adm, name, mrn, gender):
    """For each modelled lab with >=2 measurements, predict at its last event."""
    age = float(adm["age"].iloc[0]) if pd.notna(adm["age"].iloc[0]) else None
    labs = {}
    panels = set()
    for lab in sorted({e["lab"] for e in reg.entries.values()}):
        if lab not in adm.columns:
            continue
        meas = adm[lab].dropna()
        if len(meas) < 2:
            continue
        i = adm.index.get_loc(meas.index[-1])  # positional index of last measurement
        feats = features_for_lab(reg, lab, gender, adm, i)
        if feats is None:
            continue
        prev_key = f"prev1_{lab}"
        if prev_key not in feats:
            continue  # need a previous value to define the stability window
        labs[lab] = {
            "features": feats,
            "prev1": feats[prev_key],
            "actual_next": round(float(meas.iloc[-1]), 4),
        }
        fam = reg.entries[reg.resolve_key(lab, gender)].get("profile_family")
        if fam:
            panels.add(fam)
    return {
        "id": mrn.lower(),
        "name": name,
        "mrn": mrn,
        "age": round(age) if age else None,
        "sex": "M" if gender == "M" else "F",
        "scenario": f"Real-derived admission · {len(labs)} labs · panels: {', '.join(sorted(panels)) or 'none'}",
        "labs": labs,
    }


def main(max_patients=16, scan_cap=4000):
    """Greedy set-cover: pick real admissions until EVERY modelled lab has at least
    one demo case (real prev1 + real actual_next) so the doctor can test any test on
    real data without typing anything. Richer admissions are tried first; an admission
    is kept only if it still adds a not-yet-covered lab (or to seed a couple of rich
    all-rounders). Labs covered by more than one patient are a bonus.
    """
    reg = get_registry()
    target = {e["lab"] for e in reg.entries.values()}  # every modelled lab name
    df = pd.read_csv(DATA, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["hospitaladmission"] = pd.to_datetime(df["hospitaladmission"], errors="coerce")

    grp = df.groupby(["id", "admissionnumber"])
    sizes = grp.size().sort_values(ascending=False)

    written, covered, mi, fi, scanned = [], set(), 0, 0, 0
    for (pid, admnum), _ in sizes.items():
        if len(written) >= max_patients or covered >= target:
            break
        scanned += 1
        if scanned > scan_cap:
            break
        adm = grp.get_group((pid, admnum)).sort_values(
            ["date", "test_number_in_admission"]
        ).reset_index(drop=True)
        gender = "M" if str(adm["gender"].iloc[0]).startswith("M") else "F"
        name = (MALE_NAMES if gender == "M" else FEMALE_NAMES)[
            (mi if gender == "M" else fi) % len(MALE_NAMES if gender == "M" else FEMALE_NAMES)]
        patient = build_patient(reg, adm, name, "TBD", gender)
        labset = set(patient["labs"])
        if len(labset) < 5:
            continue
        new = labset - covered
        # keep the first 4 rich all-rounders for variety, then only if it adds coverage
        if new or len(written) < 4:
            if gender == "M":
                mi += 1
            else:
                fi += 1
            patient["mrn"] = f"{500000 + len(written) * 1234 + 7:06d}"
            patient["id"] = patient["mrn"].lower()
            written.append(patient)
            covered |= labset

    # clear previously generated demo json (keep nothing stale), then write
    for old in OUT.glob("*.json"):
        old.unlink()
    for p in written:
        path = OUT / f"{p['id']}.json"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(p, fh, indent=2, ensure_ascii=False)
        print(f"wrote {path.name}: {p['name']} ({p['sex']}, age {p['age']}) "
              f"-> {len(p['labs'])} labs")
    missing = sorted(target - covered)
    print(f"\nTotal patients: {len(written)} | labs covered: {len(covered)}/{len(target)}")
    if missing:
        print(f"NOT covered (no admission had 2+ real measurements): {missing}")


if __name__ == "__main__":
    main()
