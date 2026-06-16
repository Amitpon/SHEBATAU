"""Request/response models for the API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class PredictRequest(BaseModel):
    lab: str
    patient_id: Optional[str] = None
    # Optional overrides so edited demo-patient values flow straight through.
    features: Optional[dict[str, float]] = None
    prev1: Optional[float] = None
    sex: Optional[str] = None
    actual_next: Optional[float] = None
    decision_threshold: float = Field(0.85, ge=0.0, le=1.0)
    model: str = "ngboost"
    models: Optional[List[str]] = None  # e.g. ["ngboost", "mae"] for side-by-side comparison
    # {lab: threshold} - user-edited stability windows from the Settings panel
    stability_overrides: Optional[dict[str, float]] = None


class ProfileRequest(BaseModel):
    labs: list[str]
    patient_id: Optional[str] = None
    # optional per-lab feature overrides: {lab: {feature: value}}
    features: Optional[dict[str, dict[str, float]]] = None
    decision_threshold: float = Field(0.85, ge=0.0, le=1.0)
    model: str = "ngboost"
    models: Optional[List[str]] = None  # e.g. ["ngboost", "mae"] for side-by-side comparison
    # {lab: threshold} - user-edited stability windows from the Settings panel
    stability_overrides: Optional[dict[str, float]] = None


class CorrelationRequest(BaseModel):
    """Explore the internal correlation/homogeneity of any ad-hoc set of labs."""
    labs: list[str]
