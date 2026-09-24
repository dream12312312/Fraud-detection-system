"""SentinelPay Fraud Scoring Engine (FastAPI).

Loads the trained model produced by services/ml/train_model.py (MLflow artifact).
If no model is available, a deterministic heuristic is used so the platform
still demonstrates real-time decisions end to end.
"""
import os
import time
import joblib
import numpy as np
from pathlib import Path
from typing import Optional
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODEL_PATH = Path(os.getenv("MODEL_PATH", Path(__file__).resolve().parents[1] / "ml" / "artifacts" / "model.joblib"))
SCALER_PATH = MODEL_PATH.parent / "scaler.joblib"
FEATURES_PATH = MODEL_PATH.parent / "features.json"

app = FastAPI(title="SentinelPay Fraud Scoring Engine", version="1.0.0")

model = None
scaler = None
feature_names: list[str] = []


def load_model():
    global model, scaler, feature_names
    if MODEL_PATH.exists():
        model = joblib.load(MODEL_PATH)
        if SCALER_PATH.exists():
            scaler = joblib.load(SCALER_PATH)
        import json
        if FEATURES_PATH.exists():
            feature_names = json.loads(FEATURES_PATH.read_text())
        print(f"[engine] model loaded from {MODEL_PATH}")
    else:
        print("[engine] no trained model found, heuristic mode active")


class ScoreRequest(BaseModel):
    transaction_id: str
    user_id: str
    amount: float = Field(gt=0)
    type: str = "TRANSFER"
    merchant_category: Optional[str] = None
    country: str = "US"
    home_country: str = "US"
    is_new_beneficiary: bool = False
    channel: str = "WEB"
    timestamp: Optional[str] = None
    hour_of_day: Optional[int] = None
    velocity_1h: int = 0
    avg_amount_30d: float = 50.0


class ScoreResponse(BaseModel):
    transaction_id: str
    fraud_probability: float
    risk_level: str
    decision: str
    reasons: list[str]
    model_version: str
    source: str
    latency_ms: float


def build_features(req: ScoreRequest) -> tuple[list[float], list[str]]:
    hour = req.hour_of_day
    if hour is None and req.timestamp:
        hour = int(req.timestamp[11:13])
    if hour is None:
        hour = 12

    feats = {
        "amount": req.amount,
        "amount_vs_avg": req.amount / max(req.avg_amount_30d, 1.0),
        "is_night": 1.0 if hour < 6 else 0.0,
        "hour": float(hour),
        "is_new_beneficiary": 1.0 if req.is_new_beneficiary else 0.0,
        "is_foreign": 1.0 if req.country != req.home_country else 0.0,
        "velocity_1h": float(req.velocity_1h),
        "is_payment": 1.0 if req.type == "PAYMENT" else 0.0,
    }
    names = list(feats)
    return [feats[n] for n in names], names


def heuristic_reasons(req: ScoreRequest, feats: dict[str, float]) -> dict[str, bool]:
    """Which of the rule reasons apply to this request (used alongside ML scores)."""
    return {
        "AMOUNT_MUCH_HIGHER_THAN_AVG": feats["amount_vs_avg"] > 10,
        "AMOUNT_HIGHER_THAN_AVG": 4 < feats["amount_vs_avg"] <= 10,
        "NIGHT_TIME_LARGE_AMOUNT": bool(feats["is_night"]) and req.amount > 1000,
        "NEW_COUNTRY": feats["is_foreign"] > 0,
        "NEW_BENEFICIARY": feats["is_new_beneficiary"] > 0,
        "HIGH_VELOCITY": feats["velocity_1h"] >= 5,
        "HIGH_VALUE_TRANSACTION": req.amount > 9000,
    }


def heuristic_score(req: ScoreRequest, feats: dict[str, float]) -> tuple[float, list[str]]:
    """Fallback scorer mirroring the fallback rule engine in the Core API.

    Calibrated so a realistic suspicious transaction actually crosses a decision
    boundary: a foreign-country transfer from a US user is at minimum MEDIUM/REVIEW,
    and foreign + large is HIGH/BLOCK. (The old version topped out at ~0.27 for a
    plain foreign transfer, which silently APPROVED everything.)
    """
    p = 0.02
    reasons = []
    if feats["amount_vs_avg"] > 10:
        p += 0.45; reasons.append("AMOUNT_12X_USER_AVG" if feats["amount_vs_avg"] > 12 else "AMOUNT_MUCH_HIGHER_THAN_AVG")
    elif feats["amount_vs_avg"] > 4:
        p += 0.25; reasons.append("AMOUNT_HIGHER_THAN_AVG")
    if feats["is_night"] and req.amount > 1000:
        p += 0.20; reasons.append("NIGHT_TIME_LARGE_AMOUNT")
    if feats["is_foreign"]:
        p += 0.35; reasons.append("NEW_COUNTRY")
        if req.amount > 2000:
            p += 0.20; reasons.append("FOREIGN_LARGE_AMOUNT")
    if feats["is_new_beneficiary"]:
        p += 0.10; reasons.append("NEW_BENEFICIARY")
        if req.amount > 2000:
            p += 0.20; reasons.append("NEW_BENEFICIARY_LARGE_AMOUNT")
    if feats["velocity_1h"] >= 5:
        p += 0.20; reasons.append("HIGH_VELOCITY")
    if req.amount > 9000:
        p += 0.30; reasons.append("HIGH_VALUE_TRANSACTION")
    return min(p, 0.99), reasons


@app.on_event("startup")
def _startup():
    load_model()


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None, "features": len(feature_names)}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest):
    t0 = time.perf_counter()
    values, names = build_features(req)
    if model is not None and feature_names:
        X = np.array([[values[names.index(f)] if f in names else 0.0 for f in feature_names]])
        if scaler is not None:
            X = scaler.transform(X)
        p = float(model.predict_proba(X)[0][1]) if hasattr(model, "predict_proba") else float(model.predict(X)[0])
        source = "ML_MODEL"
        version = getattr(model, "_model_version", "mlflow")
    else:
        feat_map = dict(zip(names, values))
        p, reasons = heuristic_score(req, feat_map)
        source, version = "HEURISTIC", "heuristic-v1"
    if source == "ML_MODEL":
        reasons = list(reasons)
        # Combine the statistical model score with the interpretable rule reasons
        # so admins/users see *why* a transaction was flagged, not just a number.
        for reason, cond in heuristic_reasons(req, feat_map).items():
            if cond:
                reasons.append(reason)
        if not reasons:
            if p >= 0.7:
                reasons.append("MODEL_HIGH_RISK")
            elif p >= 0.3:
                reasons.append("MODEL_MEDIUM_RISK")

    if p >= 0.70:
        level, decision = "HIGH", "BLOCK"
    elif p >= 0.30:
        level, decision = "MEDIUM", "REVIEW"
    else:
        level, decision = "LOW", "APPROVE"

    return ScoreResponse(
        transaction_id=req.transaction_id,
        fraud_probability=round(p, 4),
        risk_level=level,
        decision=decision,
        reasons=reasons,
        model_version=version,
        source=source,
        latency_ms=round((time.perf_counter() - t0) * 1000, 2),
    )
