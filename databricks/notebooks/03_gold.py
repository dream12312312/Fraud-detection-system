# Databricks notebook source
# MAGIC %md
# MAGIC ## Gold layer - ML features, predictions, KPIs
# MAGIC 1. `gold_user_behavior` - per-user behaviour features
# MAGIC 2. `gold_fraud_predictions` - every fraud decision with its transaction facts
# MAGIC 3. `gold_fraud_kpis` - hourly fraud KPIs for the admin dashboard

# COMMAND ----------

import json
from pyspark.sql.functions import (col, count, countDistinct, avg, max as _max,
                                   sum as _sum, when, date_trunc)

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
txns = spark.table(f"{catalog}.{schema}.silver_events").filter(col("event") == "transaction.created")

behavior = (
    txns.filter(col("user_id").isNotNull())
    .groupBy("user_id")
    .agg(
        count("*").alias("txn_count_total"),
        avg("amount").alias("avg_amount"),
        _max("amount").alias("max_amount"),
        countDistinct("country").alias("distinct_countries"),
        _sum(when(col("status") == "BLOCKED", 1).otherwise(0)).alias("blocked_count"),
    )
)
behavior.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{catalog}.{schema}.gold_user_behavior")

preds = txns.filter(col("decision").isNotNull()).select(
    "transaction_id", "user_id", "amount", "country", "fraud_probability", "risk_level",
    "decision", "decision_source", "model_version", "status", "event_time")
preds.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{catalog}.{schema}.gold_fraud_predictions")

kpis = (
    txns.withColumn("hour", date_trunc("hour", col("event_time")))
    .groupBy("hour")
    .agg(
        count("*").alias("tx_count"),
        _sum(when(col("status") == "BLOCKED", 1).otherwise(0)).alias("blocked"),
        _sum(when(col("status") == "CHALLENGED", 1).otherwise(0)).alias("challenged"),
        _sum(when(col("status") == "COMPLETED", 1).otherwise(0)).alias("completed"),
        avg("amount").alias("avg_amount"),
        avg("fraud_probability").alias("avg_fraud_probability"),
    )
)
kpis.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{catalog}.{schema}.gold_fraud_kpis")

summary = {"users": behavior.count(), "predictions": preds.count(), "kpi_hours": kpis.count()}
print(f"gold tables written: {summary}")
dbutils.notebook.exit(json.dumps(summary))
