# Databricks notebook source
# MAGIC %md
# MAGIC ## SentinelPay — Model Training (manual, triggered from Admin console)
# MAGIC Runs as Databricks Job `sentinelpay-model-training`.
# MAGIC Trains a fraud classifier, logs metrics/params/artifacts to **workspace MLflow**
# MAGIC (visible in the Databricks MLflow UI), and prints a summary the admin console
# MAGIC surfaces via the Jobs API.
import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (precision_score, recall_score, f1_score,
                             roc_auc_score, average_precision_score)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

CATALOG = "fraud"
SCHEMA = "analytics"
SEED = 42

# --- 1. training data: synthetic-but-real behavioral dataset built in SQL -------
# Prefer the platform's own gold data when it has enough fraud signal; otherwise
# fall back to the classic creditcard dataset so the first training run works.
def _spark_has(name):
    try:
        spark.table(name)
        return True
    except Exception:
        return False

try:
    src = spark.table(f"{CATALOG}.{SCHEMA}.silver_events").filter("event = 'transaction.created'")
    df = src.select("amount", "status").toPandas()
    df = df[df["status"].isin(["COMPLETED", "BLOCKED", "CHALLENGED"])]
    df["Class"] = (df["status"] == "BLOCKED").astype(int)
    df = df[["amount", "Class"]]
    assert df["Class"].nunique() == 2 and len(df) >= 200, "not enough platform data"
    source_note = f"{CATALOG}.{SCHEMA}.silver_events"
except Exception as e:
    print(f"[train] platform data insufficient ({e}); using creditcard dataset")
    if _spark_has("samples.banking.creditcard"):
        df = spark.read.table("samples.banking.creditcard").toPandas()
    else:
        df = None
    source_note = "creditcard"

if df is None:
    from sklearn.datasets import fetch_openml
    df = fetch_openml(data_id=1597, as_frame=True, parser="auto").frame
    df["Class"] = df["Class"].astype(int)

print(f"[train] dataset: {source_note} · {len(df):,} rows · {int(df['Class'].sum()):,} fraud")

X = df.drop(columns=["Class"])
y = df["Class"].astype(int)
if "Amount" in X.columns:
    X = X.assign(hour=0.0, is_night=0.0, log_amount=np.log1p(X["Amount"]))
if "Time" in X.columns:
    X = X.assign(hour=(X["Time"] // 3600) % 24, is_night=((X["Time"] // 3600) % 24 < 6).astype(float))

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, stratify=y, random_state=SEED)

candidates = {
    "logistic_regression": Pipeline([("scaler", StandardScaler()),
        ("clf", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=SEED))]),
    "random_forest": RandomForestClassifier(n_estimators=120, class_weight="balanced",
                                            random_state=SEED, n_jobs=-1),
}

mlflow.set_experiment("sentinelpay-fraud")

results, best = {}, (None, -1.0, None)
for name, model in candidates.items():
    with mlflow.start_run(run_name=name) as run:
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
        mlflow.log_metrics(metrics)
        mlflow.log_params({"model": name, "n_train": len(X_train), "n_test": len(X_test),
                           "features": X.shape[1], "dataset": source_note})
        results[name] = metrics
        print(f"[train] {name:22s} {metrics}")
        if metrics["pr_auc"] > best[1]:
            best = (name, metrics["pr_auc"], (model, run))

print(f"[train] champion: {best[0]} (PR-AUC={best[1]})")
print(f"[train] champion MLflow run: {best[2][1].info.run_id}")
