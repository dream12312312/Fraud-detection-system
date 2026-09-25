# Databricks notebook source
# MAGIC %md
# MAGIC ## Bronze layer - raw events
# MAGIC Auto Loader ingests the JSON files landed in the UC Volume (by the API's
# MAGIC "land to lakehouse" export or the Kafka lake-ingest bridge).
# MAGIC Append-only, schema-on-read, plus ingestion metadata.

# COMMAND ----------

import json
from pyspark.sql.functions import col, current_timestamp

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
volume = f"/Volumes/{catalog}/landing/events"
target = f"{catalog}.{schema}.bronze_events"

before = spark.table(target).count() if spark.catalog.tableExists(target) else 0

df = (
    spark.readStream.format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", f"{volume}/_meta/schema/bronze")
    .option("cloudFiles.schemaEvolutionMode", "rescue")
    .option("pathGlobFilter", "*.json")
    .load(f"{volume}/data")
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_source_file", col("_metadata.file_path"))
)

(
    df.writeStream.format("delta")
    .option("checkpointLocation", f"{volume}/_meta/checkpoints/bronze")
    .option("mergeSchema", "true")
    .trigger(availableNow=True)
    .toTable(target)
    .awaitTermination()
)

after = spark.table(target).count()
print(f"bronze written -> {target}: {before} -> {after} rows")
dbutils.notebook.exit(json.dumps({"table": target, "rows_before": before, "rows_after": after, "new_rows": after - before}))
