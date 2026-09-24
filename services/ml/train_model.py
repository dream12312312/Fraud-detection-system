"""SentinelPay ML training pipeline.

1. Downloads a public credit-card fraud dataset automatically (OpenML, free, no auth).
   Dataset: creditcard (OpenML id 1597) - 284,807 transactions, 492 frauds (~0.17%).
2. Performs feature engineering.
3. Trains LogisticRegression, RandomForest and XGBoost (if installed).
4. Evaluates with Precision / Recall / F1 / ROC-AUC / PR-AUC.
5. Logs everything to MLflow and exports the champion model as a joblib artifact
   consumed by services/fraud-engine/app.py.

Run:  python train_model.py
"""
import json
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (precision_score, recall_score, f1_score,
                             roc_auc_score, average_precision_score)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
DATA = HERE / "data"
DATA.mkdir(exist_ok=True)
CSV_PATH = DATA / "creditcard.csv"

SEED = 42
TEST_SIZE = 0.25


def download_dataset() -> pd.DataFrame:
    """Download the creditcard dataset once and cache it locally."""
    if CSV_PATH.exists():
        return pd.read_csv(CSV_PATH)
    print("[train] downloading creditcard dataset from OpenML (cached after first run)...")
    from sklearn.datasets import fetch_openml
    df = fetch_openml(data_id=1597, as_frame=True, parser="auto").frame
    df["Class"] = df["Class"].astype(int)
    df.to_csv(CSV_PATH, index=False)
    print(f"[train] saved {CSV_PATH} ({len(df):,} rows)")
    return df


def feature_engineering(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    """Domain features consistent with the real-time Fraud Engine (§9.3 of README)."""
    if "Time" in df.columns:
        df["hour"] = (df["Time"] // 3600) % 24
        df["is_night"] = (df["hour"] < 6).astype(float)
        df["log_amount"] = np.log1p(df["Amount"])
    y = df["Class"]
    X = df.drop(columns=["Class"])
    feature_names = list(X.columns)
    return X, y, feature_names


def evaluate(name, model, X_train, y_train, X_test, y_test) -> dict:
    model.fit(X_train, y_train)
    proba = model.predict_proba(X_test)[:, 1]
    preds = (proba >= 0.5).astype(int)
    metrics = {
        "precision": round(precision_score(y_test, preds), 4),
        "recall": round(recall_score(y_test, preds), 4),
        "f1": round(f1_score(y_test, preds), 4),
        "roc_auc": round(roc_auc_score(y_test, proba), 4),
        "pr_auc": round(average_precision_score(y_test, proba), 4),
    }
    print(f"[train] {name:22s} {metrics}")
    return metrics


def main():
    import mlflow

    mlflow.set_experiment("sentinelpay-fraud")

    df = download_dataset()
    X, y, feature_names = feature_engineering(df)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=TEST_SIZE, stratify=y, random_state=SEED
    )

    candidates = {
        "logistic_regression": Pipeline([
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=SEED)),
        ]),
        "random_forest": RandomForestClassifier(
            n_estimators=150, class_weight="balanced", random_state=SEED, n_jobs=-1
        ),
    }
    try:
        from xgboost import XGBClassifier
        candidates["xgboost"] = XGBClassifier(
            n_estimators=300, max_depth=6, learning_rate=0.1,
            scale_pos_weight=(y_train == 0).sum() / max((y_train == 1).sum(), 1),
            random_state=SEED, n_jobs=-1, eval_metric="logloss"
        )
    except ImportError:
        print("[train] xgboost not installed, skipping")

    results = {}
    best_name, best_pr_auc, best_model = None, -1.0, None
    for name, model in candidates.items():
        with mlflow.start_run(run_name=name):
            metrics = evaluate(name, model, X_train, y_train, X_test, y_test)
            mlflow.log_metrics(metrics)
            mlflow.log_param("n_train", len(X_train))
            mlflow.log_param("n_test", len(X_test))
            mlflow.log_param("features", len(feature_names))
            mlflow.log_artifact(CSV_PATH.parent.as_posix(), artifact_path="dataset_info")
            results[name] = metrics
            if metrics["pr_auc"] > best_pr_auc:  # imbalanced data: PR-AUC is the primary metric
                best_pr_auc, best_name, best_model = metrics["pr_auc"], name, model

    print(f"[train] champion: {best_name} (PR-AUC={best_pr_auc})")

    # Export champion model + scaler info for the Fraud Engine
    scaler = None
    if hasattr(best_model, "named_steps") and "scaler" in best_model.named_steps:
        scaler = best_model.named_steps["scaler"]
        core_model = best_model.named_steps["clf"]
    else:
        core_model = best_model
    core_model._model_version = best_name
    joblib.dump(core_model, ARTIFACTS / "model.joblib")
    if scaler is not None:
        joblib.dump(scaler, ARTIFACTS / "scaler.joblib")
    (ARTIFACTS / "features.json").write_text(json.dumps(feature_names))
    (ARTIFACTS / "results.json").write_text(json.dumps({"champion": best_name, "results": results}, indent=2))
    print(f"[train] artifacts exported to {ARTIFACTS}")


if __name__ == "__main__":
    main()
