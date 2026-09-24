# Databricks notebook source
from pyspark.sql.functions import col, current_timestamp
# MAGIC %md
# MAGIC ## Bronze layer - raw events
# MAGIC Auto Loader ingests JSON files landed in the UC Volume by the Lake Ingest Bridge.
# MAGIC Append-only, schema-on-read, plus ingestion metadata. Quarantine nothing yet.

catalog = "fraud"
schema = "analytics"
volume = f"/Volumes/{catalog}/landing/events"

target = f"{catalog}.{schema}.bronze_events"

df = (
    spark.readStream.format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", f"/Volumes/{catalog}/landing/_schema/bronze")
    .option("cloudFiles.schemaEvolutionMode", "rescue")
    .load(volume)
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_source_file", col("_metadata.file_name"))
)

query = (
    df.writeStream.format("delta")
    .option("checkpointLocation", f"/Volumes/{catalog}/landing/_ckpt/bronze")
    .option("mergeSchema", "true")
    .trigger(availableNow=True)
    .toTable(target)
)
query.awaitTermination()
print(f"bronze written -> {target}")
