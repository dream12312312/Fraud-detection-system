# Databricks notebook source
# MAGIC %md
# MAGIC ## Silver layer - cleaned & conformed
# MAGIC Cast types, enforce a data contract, de-duplicate by event identity and
# MAGIC move invalid rows into a quarantine table.

# COMMAND ----------

import json
from pyspark.sql.functions import col, lit, to_timestamp, coalesce

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
bronze = f"{catalog}.{schema}.bronze_events"
silver = f"{catalog}.{schema}.silver_events"
quarantine = f"{catalog}.{schema}.silver_quarantine"

raw = spark.table(bronze)

# Typed view of the contract; columns missing from older files become null.
def c(name, dtype):
    return (col(name) if name in raw.columns else lit(None)).cast(dtype).alias(name)

typed = raw.select(
    c("event", "string"), c("transaction_id", "string"), c("user_id", "string"),
    c("amount", "double"), c("type", "string"), c("country", "string"), c("home_country", "string"),
    c("is_new_beneficiary", "boolean"), c("hour_of_day", "int"), c("velocity_1h", "int"),
    c("avg_amount_30d", "double"), c("status", "string"), c("decision", "string"),
    c("risk_level", "string"), c("fraud_probability", "double"), c("decision_source", "string"),
    c("model_version", "string"), c("reasons", "string"), c("source", "string"),
    to_timestamp(coalesce(col("created_at") if "created_at" in raw.columns else lit(None),
                          col("published_at") if "published_at" in raw.columns else lit(None))).alias("event_time"),
    col("_ingested_at"),
)

rules = (
    col("transaction_id").isNotNull() & col("event").isNotNull()
    & col("amount").isNotNull() & (col("amount") > 0) & col("event_time").isNotNull()
)
validated = typed.withColumn("_dq_ok", rules)

bad = validated.filter(~col("_dq_ok")).drop("_dq_ok")
clean = validated.filter(col("_dq_ok")).drop("_dq_ok").dropDuplicates(["event", "transaction_id"])

bad.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(quarantine)
clean.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(silver)

summary = {"input_rows": typed.count(), "silver_rows": spark.table(silver).count(), "quarantined": spark.table(quarantine).count()}
print(f"silver written -> {silver}: {summary}")
dbutils.notebook.exit(json.dumps(summary))
