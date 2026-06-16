"""Demo-patient store. Each file under data/patients/*.json holds a patient's lab
history (the inputs the models need) plus a hidden ``actual_next`` per lab used only
for the 'Warning Verification' panel. Patients are editable in the UI before running.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATIENTS_DIR = ROOT / "data" / "patients"


def list_patients() -> list[dict]:
    out = []
    for path in sorted(PATIENTS_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as fh:
            out.append(json.load(fh))
    return out


def get_patient(patient_id: str) -> dict | None:
    for p in list_patients():
        if p.get("id") == patient_id:
            return p
    return None
