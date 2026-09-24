# Databricks notebook source
from pyspark.sql.functions import (col, count, countDistinct, avg, max as _max,
                                   sum as _sum, when, date_trunc)

# MAGIC %md
# MAGIC ## Gold layer - ML features, predictions, KPIs
# MAGIC 1. `gold_user_behavior` - per-user rolling features (avg amount, txn counts)
# MAGIC 2. `gold_fraud_predictions` - decision history joined with transaction facts
# MAGIC 3. `gold_fraud_kpis` - hourly fraud KPI aggregates for the Admin dashboard

catalog = "fraud"
schema = "analytics"
silver = spark.table(f"{catalog}.{schema}.silver_events")

# --- user behavior features -------------------------------------------------
behavior = (
    silver.filter(col("user_id").isNotNull())
    .groupBy("user_id")
    .agg(
        count("*").alias("txn_count_total"),
        avg("amount").alias("avg_amount"),
        max("amount").alias("max_amount"),
        countDistinct("country").alias("distinct_countries"),
    )
)
behavior.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{catalog}.{schema}.gold_user_behavior")

# --- predictions history ----------------------------------------------------
preds = silver.filter(col("event") == "transaction.decision")
preds.write.mode("append").saveAsTable(f"{catalog}.{schema}.gold_fraud_predictions")

# --- hourly KPIs ------------------------------------------------------------
kpis = (
    silver.filter(col("event") == "transaction.created")
    .withColumn("hour", date_trunc("hour", col("published_at").cast("timestamp")))
    .groupBy("hour")
    .agg(
        count("*").alias("tx_count"),
        sum(when(col("status") == "BLOCKED", 1).otherwise(0)).alias("blocked"),
        sum(when(col("status") == "CHALLENGED", 1).otherwise(0)).alias("challenged"),
        sum(when(col("status") == "COMPLETED", 1).otherwise(0)).alias("completed"),
        avg("amount").alias("avg_amount"),
    )
)
kpis.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{catalog}.{schema}.gold_fraud_kpis")
print("gold tables written")
