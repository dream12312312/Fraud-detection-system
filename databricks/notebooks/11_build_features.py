# Databricks notebook source
# MAGIC %md
# MAGIC ## Training stage 2 - feature engineering + data quality
# MAGIC Builds the model features from `ml_dataset` into `ml_features`, drops rows
# MAGIC that fail quality checks and assigns a seeded, stratified train/test split.
# MAGIC For engine-compatible datasets the features are **exactly** the ones the live
# MAGIC fraud engine computes (`services/fraud-engine/app.py build_features`).

# COMMAND ----------

# MAGIC %pip install -q scikit-learn==1.6.0

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import json
import numpy as np
from sklearn.model_selection import train_test_split

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
dbutils.widgets.text("seed", "42")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
seed = int(dbutils.widgets.get("seed") or 42)

pdf = spark.table(f"{catalog}.{schema}.ml_dataset").toPandas()
rows_in = len(pdf)
engine_compatible = "avg_amount_30d" in pdf.columns

if engine_compatible:
    pdf = pdf.dropna(subset=["amount", "label"])
    pdf = pdf[pdf["amount"] > 0]
    feats = {
        "amount": pdf["amount"].astype(float),
        "amount_vs_avg": pdf["amount"] / pdf["avg_amount_30d"].fillna(pdf["amount"]).clip(lower=1.0),
        "is_night": (pdf["hour_of_day"].fillna(12) < 6).astype(float),
        "hour": pdf["hour_of_day"].fillna(12).astype(float),
        "is_new_beneficiary": pdf["is_new_beneficiary"].fillna(False).astype(float),
        "is_foreign": (pdf["country"].fillna("US") != pdf["home_country"].fillna("US")).astype(float),
        "velocity_1h": pdf["velocity_1h"].fillna(0).astype(float),
        "is_payment": (pdf["type"] == "PAYMENT").astype(float),
    }
    out = pdf[["label"]].copy()
    for k, v in feats.items():
        out[k] = v.values
else:
    pdf = pdf.dropna()
    out = pdf.drop(columns=["Time"], errors="ignore").copy()
    if "Amount" in out.columns:
        out["log_amount"] = np.log1p(out["Amount"].astype(float))
    if "Time" in pdf.columns:
        out["hour"] = ((pdf["Time"].astype(float) // 3600) % 24).values

feature_names = [c for c in out.columns if c != "label"]
out["label"] = out["label"].astype(int)
train_idx, test_idx = train_test_split(out.index, test_size=0.25, stratify=out["label"], random_state=seed)
out["split"] = "train"
out.loc[test_idx, "split"] = "test"

spark.createDataFrame(out.reset_index(drop=True)).write.mode("overwrite").option("overwriteSchema", "true") \
    .saveAsTable(f"{catalog}.{schema}.ml_features")

summary = {"rows_in": rows_in, "rows_after_quality": len(out), "dropped_rows": rows_in - len(out),
           "n_features": len(feature_names), "feature_names": feature_names,
           "n_train": int((out["split"] == "train").sum()), "n_test": int((out["split"] == "test").sum()),
           "engine_compatible": engine_compatible}
print(summary)
dbutils.notebook.exit(json.dumps(summary))
