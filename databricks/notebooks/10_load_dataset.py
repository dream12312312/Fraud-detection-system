# Databricks notebook source
# MAGIC %md
# MAGIC ## Training stage 1 - load the chosen dataset
# MAGIC Part of job `sentinelpay-model-training` (started manually from the admin console).
# MAGIC Writes the raw training rows to `<catalog>.<schema>.ml_dataset` (a Delta table,
# MAGIC so every run records exactly which table version it trained on).
# MAGIC
# MAGIC | dataset | source | engine-compatible |
# MAGIC |---|---|---|
# MAGIC | `synthetic_payments` | seeded generator, 50k payments, no download | yes |
# MAGIC | `platform_transactions` | this platform's own `silver_events` (lakehouse) | yes |
# MAGIC | `creditcard_benchmark` | public creditcard dataset (OpenML 1597), cached once as a Delta table | no (anonymised PCA features) |

# COMMAND ----------

# MAGIC %pip install -q scikit-learn==1.6.0

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import json
import numpy as np
import pandas as pd

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
dbutils.widgets.text("dataset", "synthetic_payments")
dbutils.widgets.text("seed", "42")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
dataset = dbutils.widgets.get("dataset")
seed = int(dbutils.widgets.get("seed") or 42)
target = f"{catalog}.{schema}.ml_dataset"


def synthetic_payments(n=50_000, seed=42):
    """Seeded, documented generator for payments with the same raw fields the
    live platform records. Fraud is drawn from a latent risk model with noise, so
    no single rule separates the classes perfectly."""
    rng = np.random.default_rng(seed)
    avg30 = rng.lognormal(3.8, 0.6, n)
    ratio = rng.lognormal(0.0, 0.7, n)
    amount = np.round(avg30 * ratio, 2)
    hour = rng.choice(24, n, p=np.r_[np.full(6, 0.012), np.full(18, (1 - 0.072) / 18)])
    new_ben = rng.random(n) < 0.25
    foreign = rng.random(n) < 0.08
    velocity = rng.poisson(0.8, n)
    payment = rng.random(n) < 0.5
    night = hour < 6
    logit = (-5.4 + 1.5 * np.log(np.clip(ratio, 0.05, 50)) + 1.7 * foreign + 0.9 * new_ben
             + 1.3 * (night & (amount > 300)) + 0.45 * velocity - 0.3 * payment
             + rng.normal(0, 0.9, n))
    label = rng.random(n) < 1 / (1 + np.exp(-logit))
    return pd.DataFrame({
        "amount": amount, "avg_amount_30d": np.round(avg30, 2), "hour_of_day": hour,
        "is_new_beneficiary": new_ben, "country": np.where(foreign, "GB", "US"), "home_country": "US",
        "velocity_1h": velocity, "type": np.where(payment, "PAYMENT", "TRANSFER"), "label": label.astype(int),
    })


if dataset == "synthetic_payments":
    pdf = synthetic_payments(seed=seed)
    source = f"generator(seed={seed})"
    df = spark.createDataFrame(pdf)
    engine_compatible = True
elif dataset == "platform_transactions":
    src = f"{catalog}.{schema}.silver_events"
    if not spark.catalog.tableExists(src):
        raise Exception(f"{src} does not exist yet - land transactions and run the medallion pipeline first")
    df = spark.sql(f"""
        SELECT amount, avg_amount_30d, hour_of_day, is_new_beneficiary, country, home_country,
               velocity_1h, type,
               CAST(status = 'BLOCKED' OR coalesce(reasons, '') LIKE '%USER_REPORTED_FRAUD%' AS INT) AS label
        FROM {src}
        WHERE event = 'transaction.created' AND type IN ('TRANSFER', 'PAYMENT')
          AND status IN ('COMPLETED', 'BLOCKED', 'CHALLENGED')
    """)
    source = src
    engine_compatible = True
    counts = {r["label"]: r["n"] for r in df.groupBy("label").count().withColumnRenamed("count", "n").collect()}
    if len(counts) < 2 or min(counts.values()) < 5 or sum(counts.values()) < 50:
        raise Exception(f"not enough labelled platform data to train: {counts} "
                        "(need >= 50 rows and >= 5 of each class; generate traffic, land it and rerun the pipeline)")
elif dataset == "creditcard_benchmark":
    cache = f"{catalog}.{schema}.ref_creditcard"
    # Serverless compute on Free Edition has no internet egress, so the API stages the
    # OpenML parquet file into the landing volume (Model training → "Stage into lakehouse").
    staged = f"/Volumes/{catalog}/landing/events/reference/creditcard/dataset_1597.pq"
    if not spark.catalog.tableExists(cache):
        from pyspark.sql import functions as F
        try:
            raw = spark.read.parquet(staged)
            origin = staged
        except Exception as staged_err:
            try:
                from sklearn.datasets import fetch_openml
                raw = spark.createDataFrame(fetch_openml(data_id=1597, as_frame=True, parser="auto").frame)
                origin = "openml.org (direct download)"
            except Exception as net_err:
                raise Exception(
                    "creditcard_benchmark is not staged and this compute cannot reach openml.org "
                    f"({type(net_err).__name__}). In the admin console open Model training and press "
                    f"'Stage into lakehouse' for the credit-card benchmark, then start the run again. "
                    f"[expected file: {staged}]") from staged_err
        raw.withColumn("Class", F.col("Class").cast("int")).write.mode("overwrite").saveAsTable(cache)
        print(f"cached {origin} -> {cache}")
    full = spark.table(cache).withColumnRenamed("Class", "label")
    # Small, reproducible sample: every fraud row + a seeded sample of normal rows.
    fraud = full.filter("label = 1")
    normal = full.filter("label = 0").sample(fraction=0.1, seed=seed)
    df = fraud.unionByName(normal)
    source = f"{cache} (all fraud + 10% of normal, seed={seed})"
    engine_compatible = False
else:
    raise Exception(f"unknown dataset '{dataset}'")

df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(target)
version = spark.sql(f"DESCRIBE HISTORY {target} LIMIT 1").collect()[0]["version"]
rows = spark.table(target).count()
fraud_rows = spark.table(target).filter("label = 1").count()

summary = {"dataset": dataset, "source": source, "table": target, "delta_version": int(version),
           "rows": rows, "fraud_rows": fraud_rows, "fraud_rate": round(fraud_rows / max(rows, 1), 4),
           "engine_compatible": engine_compatible}
print(summary)
dbutils.jobs.taskValues.set("engine_compatible", engine_compatible)
dbutils.notebook.exit(json.dumps(summary))
