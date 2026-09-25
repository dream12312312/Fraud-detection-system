# Databricks notebook source
# MAGIC %md
# MAGIC ## Training stage 4 - evaluate against the base model, then register
# MAGIC Scores the held-out test split with the new model **and** with the base model
# MAGIC that is live today (the fraud engine's rule-based heuristic), logs both to the
# MAGIC same MLflow run, and registers the new model version in Unity Catalog.
# MAGIC Registering does not activate it: the live engine keeps the base model.

# COMMAND ----------

# MAGIC %pip install -q scikit-learn==1.6.0 "mlflow>=2.19"

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import json
import numpy as np
import mlflow
import mlflow.sklearn
from sklearn.metrics import (precision_score, recall_score, f1_score, roc_auc_score,
                             average_precision_score, accuracy_score, confusion_matrix)

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
run_id = dbutils.jobs.taskValues.get(taskKey="train_model", key="mlflow_run_id")

pdf = spark.table(f"{catalog}.{schema}.ml_features").toPandas()
test = pdf[pdf["split"] == "test"]
feature_names = [c for c in pdf.columns if c not in ("label", "split")]
X, y = test[feature_names].astype(float), test["label"].astype(int).values


def metrics(y_true, proba):
    pred = (proba >= 0.5).astype(int)
    # float(): numpy scalars are not JSON-serialisable in dbutils.notebook.exit
    return {"precision": round(float(precision_score(y_true, pred, zero_division=0)), 4),
            "recall": round(float(recall_score(y_true, pred, zero_division=0)), 4),
            "f1": round(float(f1_score(y_true, pred, zero_division=0)), 4),
            "accuracy": round(float(accuracy_score(y_true, pred)), 4),
            "roc_auc": round(float(roc_auc_score(y_true, proba)), 4),
            "pr_auc": round(float(average_precision_score(y_true, proba)), 4)}


def base_model(f):
    """The live base model: same rules as services/fraud-engine/app.py heuristic_score."""
    p = np.full(len(f), 0.02)
    r = f["amount_vs_avg"].values
    p += np.where(r > 10, 0.45, np.where(r > 4, 0.25, 0))
    p += np.where((f["is_night"] > 0) & (f["amount"] > 1000), 0.20, 0)
    foreign = f["is_foreign"] > 0
    p += np.where(foreign, 0.35, 0) + np.where(foreign & (f["amount"] > 2000), 0.20, 0)
    newb = f["is_new_beneficiary"] > 0
    p += np.where(newb, 0.10, 0) + np.where(newb & (f["amount"] > 2000), 0.20, 0)
    p += np.where(f["velocity_1h"] >= 5, 0.20, 0)
    p += np.where(f["amount"] > 9000, 0.30, 0)
    return np.minimum(p, 0.99)


model = mlflow.sklearn.load_model(f"runs:/{run_id}/model")
proba = model.predict_proba(X)[:, 1]
new_m = metrics(y, proba)
tn, fp, fn, tp = confusion_matrix(y, (proba >= 0.5).astype(int), labels=[0, 1]).ravel()

engine_compatible = "amount_vs_avg" in feature_names
base_m = metrics(y, base_model(test)) if engine_compatible else None

with mlflow.start_run(run_id=run_id):
    mlflow.log_metrics(new_m)
    mlflow.log_metrics({"tp": int(tp), "fp": int(fp), "tn": int(tn), "fn": int(fn), "n_test": len(y)})
    if base_m:
        mlflow.log_metrics({f"baseline_{k}": v for k, v in base_m.items()})

registered, version = f"{catalog}.{schema}.fraud_classifier", None
try:
    mlflow.set_registry_uri("databricks-uc")
    mv = mlflow.register_model(f"runs:/{run_id}/model", registered)
    version = str(mv.version)
except Exception as e:  # registration is reported, not hidden
    print(f"model registration failed: {e}")
    registered = None

summary = {"mlflow_run_id": run_id, "metrics": new_m, "baseline_metrics": base_m,
           "confusion": {"tp": int(tp), "fp": int(fp), "tn": int(tn), "fn": int(fn)}, "n_test": len(y),
           "beats_baseline": bool(new_m["pr_auc"] > base_m["pr_auc"]) if base_m else None,
           "registered_model": registered, "registered_version": version}
print(summary)
dbutils.notebook.exit(json.dumps(summary))
