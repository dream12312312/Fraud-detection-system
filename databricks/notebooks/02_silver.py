# Databricks notebook source
from pyspark.sql.functions import col

# MAGIC %md
# MAGIC ## Silver layer - cleaned & conformed
# MAGIC Parse JSON payloads, cast types, deduplicate by event identity, drop invalid
# MAGIC rows into a quarantine table. Join fraud decisions back onto transactions.

catalog = "fraud"
schema = "analytics"
bronze = f"{catalog}.{schema}.bronze_events"
silver = f"{catalog}.{schema}.silver_events"
quarantine = f"{catalog}.{schema}.silver_quarantine"

raw = spark.table(bronze)

# Bronze rows carry the original Kafka payload fields flattened by Auto Loader
# (schema evolves with rescue). Enforce a minimal contract:
required = ["event", "transaction_id"]
validated = raw.withColumn("_dq_ok",
    col("transaction_id").isNotNull() & col("event").isNotNull()
)

bad = validated.filter(~col("_dq_ok"))
bad.write.mode("append").saveAsTable(quarantine)

clean = (
    validated.filter(col("_dq_ok"))
    .dropDuplicates(["event", "transaction_id", "published_at"])
)

clean.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(silver)
print(f"silver written -> {silver} (quarantined {bad.count()} rows)")
