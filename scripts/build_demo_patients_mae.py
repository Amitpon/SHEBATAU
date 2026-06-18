"""Build demo patients with hidden MAE order-event tokens.

The old demo-patient builder creates NGBoost-style flat fields from merged rows.
This builder uses the final order-event dataset so each selected lab prediction can
also carry the timestamp-safe MAE tokens that were used during final training.

Outputs are still ordinary demo JSON files under ``data/patients``:

  labs[lab]["features"]      -> visible/editable flat fields for the current UI
  labs[lab]["mae_features"]  -> hidden MAE token values/time recencies

Run from ``Modeling/demo`` or from project root:

  python Modeling/demo/scripts/build_demo_patients_mae.py
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

from backend.registry import get_registry  # noqa: E402

OUT = ROOT / "data" / "patients"
MAE_DIR = ROOT / "models" / "MAE"
DEFAULT_DATA_NEW = PROJECT_ROOT.parent / "data_new"
ORDER_EVENTS = Path(os.getenv("DEMO_ORDER_EVENTS_PARQUET", DEFAULT_DATA_NEW / "order_events_full.parquet"))
ORDER_REGISTRY = Path(os.getenv("DEMO_ORDER_EVENT_REGISTRY", DEFAULT_DATA_NEW / "order_event_feature_registry.csv"))

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

META_COLS = [
    "row_id",
    "split",
    "id",
    "admission_key",
    "lab",
    "testcode",
    "order_at",
    "target_value",
    "prev_value",
    "stability_threshold",
    "actual_stable",
    "_sex",
    "age",
    "sex_numeric",
    "hospitaladmission",
    "departmentcode",
]


def _load_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _safe_float(value):
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _round(value, ndigits=4):
    value = _safe_float(value)
    return None if value is None else round(value, ndigits)


def _sex_from_row(row: pd.Series) -> str:
    raw = str(row.get("_sex", "")).upper()
    if raw.startswith("M"):
        return "M"
    if raw.startswith("F"):
        return "F"
    sex_numeric = _safe_float(row.get("sex_numeric"))
    return "M" if sex_numeric == 1.0 else "F"


def _archive_existing_patients() -> None:
    existing = sorted(OUT.glob("*.json"))
    if not existing:
        return
    archive = OUT / "archive" / f"pre_mae_phase2_{datetime.now():%Y%m%d_%H%M%S}"
    archive.mkdir(parents=True, exist_ok=True)
    for path in existing:
        shutil.move(str(path), archive / path.name)
    print(f"Archived {len(existing)} existing patient JSONs to {archive}")


def _load_feature_registry() -> pd.DataFrame:
    cfg = _load_json(MAE_DIR / "mae_config.json")
    enabled = set(cfg.get("enabled_token_types") or [])
    admin_allowlist = set(cfg.get("administrative_feature_allowlist") or [])
    registry = pd.read_csv(ORDER_REGISTRY)
    if enabled:
        registry = registry[registry["token_type"].isin(enabled)].copy()
    if admin_allowlist:
        registry = registry[
            ~registry["token_type"].eq("administrative")
            | registry["feature_code"].isin(admin_allowlist)
        ].copy()
    registry = registry.dropna(subset=["feature_code", "value_column", "time_column"])
    priority = {
        "lab_history": 0,
        "administrative": 1,
        "panel_sibling": 2,
        "unrelated_lab": 3,
    }
    registry["_priority"] = registry["token_type"].map(priority).fillna(9)
    return registry.sort_values(["_priority", "feature_code"]).drop(columns=["_priority"]).reset_index(drop=True)


def _choose_demo_rows(meta: pd.DataFrame, lab_columns: list[str], max_patients: int) -> pd.DataFrame:
    meta = meta[meta["lab"].isin(lab_columns)].copy()
    if "split" in meta:
        test_meta = meta[meta["split"].eq("test")].copy()
        if len(test_meta):
            meta = test_meta
    meta["order_at"] = pd.to_datetime(meta["order_at"], errors="coerce")
    meta = meta.sort_values(["id", "admission_key", "lab", "order_at", "row_id"])
    latest_per_lab = meta.groupby(["id", "admission_key", "lab"], as_index=False).tail(1)

    admission_labs = (
        latest_per_lab.groupby(["id", "admission_key"])["lab"]
        .agg(lambda s: sorted(set(s)))
        .reset_index(name="labs")
    )
    admission_labs["n_labs"] = admission_labs["labs"].map(len)
    admission_labs = admission_labs.sort_values("n_labs", ascending=False)

    covered: set[str] = set()
    selected_keys: list[tuple] = []
    target = set(lab_columns)
    for _, row in admission_labs.iterrows():
        if len(selected_keys) >= max_patients or covered >= target:
            break
        labs = set(row["labs"])
        if not labs:
            continue
        if labs - covered or len(selected_keys) < 4:
            selected_keys.append((row["id"], row["admission_key"]))
            covered |= labs

    selected = latest_per_lab[
        latest_per_lab[["id", "admission_key"]].apply(tuple, axis=1).isin(selected_keys)
    ].copy()
    print(
        f"Selected {len(selected_keys)} admissions, {len(selected)} lab rows, "
        f"covering {selected['lab'].nunique()}/{len(target)} MAE labs."
    )
    missing = sorted(target - set(selected["lab"]))
    if missing:
        print("MAE labs not represented in generated demo patients:", missing)
    return selected


def _read_selected_rows(row_ids: set[int], columns: list[str]) -> pd.DataFrame:
    parquet = pq.ParquetFile(ORDER_EVENTS)
    pieces = []
    for batch in parquet.iter_batches(columns=columns, batch_size=8192):
        df = batch.to_pandas()
        keep = df[df["row_id"].isin(row_ids)]
        if len(keep):
            pieces.append(keep)
    if not pieces:
        raise RuntimeError("No selected order-event rows were found while reading Parquet batches.")
    return pd.concat(pieces, ignore_index=True)


def _add_flat_feature(features: dict, key: str, value) -> None:
    value = _round(value)
    if value is not None and key not in features:
        features[key] = value


def _code_to_flat_features(code: str, value, recency_hours, features: dict) -> None:
    value = _round(value)
    if value is None:
        return
    days = _round((_safe_float(recency_hours) or 0.0) / 24.0)

    if code.endswith("__prev1"):
        lab = code[: -len("__prev1")]
        _add_flat_feature(features, f"prev1_{lab}", value)
        if days is not None:
            _add_flat_feature(features, f"days_since_last_{lab}", days)
    elif code.endswith("__first_admission"):
        lab = code[: -len("__first_admission")]
        _add_flat_feature(features, f"first_in_adm_{lab}", value)
    elif code.startswith("panel__") and code.endswith("__latest"):
        lab = code[len("panel__") : -len("__latest")]
        _add_flat_feature(features, f"prev1_{lab}", value)
        if days is not None:
            _add_flat_feature(features, f"days_since_last_{lab}", days)
    elif code.startswith("unrelated__") and code.endswith("__latest"):
        lab = code[len("unrelated__") : -len("__latest")]
        _add_flat_feature(features, f"prev1_{lab}", value)
        if days is not None:
            _add_flat_feature(features, f"days_since_last_{lab}", days)


def _build_lab_payload(row: pd.Series, feature_registry: pd.DataFrame, max_mae_tokens: int) -> dict:
    lab = str(row["lab"])
    features: dict = {}
    mae_features: dict = {}

    _add_flat_feature(features, f"prev1_{lab}", row.get("prev_value"))
    _add_flat_feature(features, "age", row.get("age"))
    _add_flat_feature(features, "sex_numeric", row.get("sex_numeric"))

    token_count = 0
    for _, spec in feature_registry.iterrows():
        if token_count >= max_mae_tokens:
            break
        code = str(spec["feature_code"])
        value_col = str(spec["value_column"])
        time_col = str(spec["time_column"])
        value = _safe_float(row.get(value_col))
        if value is None:
            continue
        recency = _safe_float(row.get(time_col)) or 0.0
        mae_features[f"mae__{code}"] = round(value, 6)
        mae_features[f"mae_time__{code}"] = round(recency, 6)
        _code_to_flat_features(code, value, recency, features)
        token_count += 1

    for src, dst in [
        ("mae__age", "age"),
        ("mae__days_in_admission", "days_in_admission"),
        ("mae__prior_lab_orders", "test_number_in_admission"),
    ]:
        if src in mae_features:
            _add_flat_feature(features, dst, mae_features[src])

    return {
        "features": features,
        "mae_features": mae_features,
        "prev1": _round(row.get("prev_value")),
        "actual_next": _round(row.get("target_value")),
        "actual_stable": bool(row.get("actual_stable")),
        "order_event_row_id": int(row["row_id"]),
        "order_at": str(row.get("order_at")),
        "mae_feature_count": token_count,
    }


def _build_patients(rows: pd.DataFrame, feature_registry: pd.DataFrame, max_mae_tokens: int) -> list[dict]:
    patients = []
    grouped = rows.sort_values(["id", "admission_key", "lab"]).groupby(["id", "admission_key"], sort=False)
    mi = fi = 0
    for idx, ((_, _), adm) in enumerate(grouped):
        first = adm.iloc[0]
        sex = _sex_from_row(first)
        names = MALE_NAMES if sex == "M" else FEMALE_NAMES
        name_idx = mi if sex == "M" else fi
        if sex == "M":
            mi += 1
        else:
            fi += 1
        labs = {
            str(row["lab"]): _build_lab_payload(row, feature_registry, max_mae_tokens)
            for _, row in adm.iterrows()
        }
        mae_counts = [payload["mae_feature_count"] for payload in labs.values()]
        mrn = f"{600000 + idx * 1234 + 7:06d}"
        patients.append(
            {
                "id": mrn.lower(),
                "name": names[name_idx % len(names)],
                "mrn": mrn,
                "age": int(round(float(first["age"]))) if pd.notna(first.get("age")) else None,
                "sex": sex,
                "scenario": (
                    f"Order-event admission · {len(labs)} labs · "
                    f"MAE tokens/lab median {int(np.median(mae_counts)) if mae_counts else 0}"
                ),
                "source": "order_events_full.parquet",
                "labs": labs,
            }
        )
    return patients


def main(max_patients: int = 16, max_mae_tokens: int | None = None) -> None:
    if not ORDER_EVENTS.exists():
        raise FileNotFoundError(f"Missing order-event Parquet: {ORDER_EVENTS}")
    if not ORDER_REGISTRY.exists():
        raise FileNotFoundError(f"Missing order-event feature registry: {ORDER_REGISTRY}")
    mae_reg = _load_json(MAE_DIR / "mae_registry.json")
    mae_cfg = _load_json(MAE_DIR / "mae_config.json")
    if max_mae_tokens is None:
        max_mae_tokens = max(1, int(mae_cfg.get("max_tokens", 32)) - 1)
    lab_columns = list(mae_reg.get("lab_columns", []))
    if not lab_columns:
        raise RuntimeError("MAE registry has no lab_columns.")

    feature_registry = _load_feature_registry()
    value_cols = feature_registry["value_column"].astype(str).tolist()
    time_cols = feature_registry["time_column"].astype(str).tolist()
    read_cols = list(dict.fromkeys(META_COLS + value_cols + time_cols))

    meta = pd.read_parquet(ORDER_EVENTS, columns=[c for c in META_COLS if c != "departmentcode" or True])
    selected_meta = _choose_demo_rows(meta, lab_columns, max_patients=max_patients)
    selected_rows = _read_selected_rows(set(selected_meta["row_id"].astype(int)), read_cols)
    selected_rows["order_at"] = pd.to_datetime(selected_rows["order_at"], errors="coerce")
    selected_rows = selected_rows.sort_values(["id", "admission_key", "lab", "order_at"])

    patients = _build_patients(selected_rows, feature_registry, max_mae_tokens=max_mae_tokens)

    OUT.mkdir(parents=True, exist_ok=True)
    _archive_existing_patients()
    for patient in patients:
        path = OUT / f"{patient['id']}.json"
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(patient, handle, indent=2, ensure_ascii=False)
        print(f"wrote {path.name}: {patient['name']} ({patient['sex']}, age {patient['age']}) -> {len(patient['labs'])} labs")

    covered = {lab for patient in patients for lab in patient["labs"]}
    print(f"\nTotal patients: {len(patients)} | MAE labs covered: {len(covered)}/{len(lab_columns)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-patients", type=int, default=16)
    parser.add_argument("--max-mae-tokens", type=int, default=None)
    args = parser.parse_args()
    main(max_patients=args.max_patients, max_mae_tokens=args.max_mae_tokens)
