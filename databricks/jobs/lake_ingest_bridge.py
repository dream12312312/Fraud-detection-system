"""SentinelPay Lake Ingest Bridge.

Consumes Kafka events and lands them as JSON files in a Databricks Unity Catalog
Volume, which Auto Loader then ingests into the Bronze Delta tables.

Design (Free Edition compatible):
- Kafka consumer group with at-most-once semantics: offsets committed only after
  files are uploaded.
- Batched micro-batches (e.g. every 30s) to stay within API rate limits.
- Pure-stdlib HTTPS via the Databricks SDK (works from any laptop).

Env vars:
  KAFKA_BROKERS, KAFKA_TOPICS (comma separated)
  DATABRICKS_HOST, DATABRICKS_TOKEN
  DATABRICKS_VOLUME_PATH (e.g. /Volumes/fraud/landing/events)
  BRIDGE_BATCH_SECONDS (default 30)
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from confluent_kafka import Consumer
from databricks.sdk import WorkspaceClient

BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
TOPICS = [t.strip() for t in os.getenv(
    "KAFKA_TOPICS", "txn.events.raw,txn.fraud.scored,txn.status.updates,user.activity,security.events"
).split(",")]
HOST = os.getenv("DATABRICKS_HOST", "").rstrip("/")
TOKEN = os.getenv("DATABRICKS_TOKEN", "")
VOLUME = os.getenv("DATABRICKS_VOLUME_PATH", "/Volumes/fraud/landing/events")
BATCH_SECONDS = int(os.getenv("BRIDGE_BATCH_SECONDS", "30"))
GROUP_ID = os.getenv("BRIDGE_GROUP_ID", "lake-ingest-bridge")


def flush_batch(w: WorkspaceClient, batch: list[dict]):
    """Group events by topic+date and upload one JSON file per group."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for ev in batch:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        groups.setdefault((ev["_topic"], day), []).append(ev)

    for (topic, day), events in groups.items():
        target = f"{VOLUME}/data/{topic}/dt={day}/"  # same tree the Bronze Auto Loader reads
        fname = f"part-{int(time.time() * 1000)}.json"
        payload = "\n".join(json.dumps(e, default=str) for e in events)
        w.files.upload(f"{target}{fname}", payload.encode("utf-8"), overwrite=True)
        print(f"[bridge] uploaded {len(events):>4} events -> {target}{fname}")


def main():
    assert HOST and TOKEN, "DATABRICKS_HOST and DATABRICKS_TOKEN are required"
    w = WorkspaceClient(host=HOST, token=TOKEN)

    c = Consumer({
        "bootstrap.servers": BROKERS,
        "group.id": GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    c.subscribe(TOPICS)
    print(f"[bridge] consuming {TOPICS} -> {VOLUME}")

    batch: list[dict] = []
    last_flush = time.time()
    while True:
        msg = c.poll(1.0)
        if msg is not None and not msg.error():
            try:
                ev = json.loads(msg.value())
                ev["_topic"] = msg.topic()
                ev["_partition"] = msg.partition()
                ev["_offset"] = msg.offset()
                batch.append(ev)
            except Exception as e:
                print(f"[bridge] bad message: {e}")
        if batch and (time.time() - last_flush) >= BATCH_SECONDS:
            try:
                flush_batch(w, batch)
                c.commit(asynchronous=False)  # at-most-once: offsets after upload
                batch = []
            except Exception as e:
                print(f"[bridge] upload failed, will retry batch: {e}")
            last_flush = time.time()


if __name__ == "__main__":
    main()
