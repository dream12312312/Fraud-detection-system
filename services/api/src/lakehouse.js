import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transaction, LakeBatch } from './models.js';
import { putVolumeFile, databricksConfigured, volumeFileExists, volumeFileSize, dbProbe } from './databricksClient.js';
import { VOLUME_PATH, CATALOG, SCHEMA } from './databricksProvision.js';

/**
 * The one event contract for the lakehouse. Kafka (txn.events.raw) and the
 * direct "land to lakehouse" export both emit exactly this shape, and
 * databricks/notebooks/02_silver.py casts/validates exactly these columns.
 */
export function transactionEvent(tx, extra = {}) {
  const f = tx.features || {};
  return {
    event: 'transaction.created',
    transaction_id: tx.txId,
    user_id: String(tx.userId?._id || tx.userId),
    amount: tx.amount,
    type: tx.type,
    country: tx.country,
    home_country: f.homeCountry ?? null,
    is_new_beneficiary: f.isNewBeneficiary ?? null,
    hour_of_day: f.hourOfDay ?? null,
    velocity_1h: f.velocity1h ?? null,
    avg_amount_30d: f.avgAmount30d ?? null,
    status: tx.status,
    decision: tx.decision ?? null,
    risk_level: tx.riskLevel ?? null,
    fraud_probability: tx.fraudProbability ?? null,
    decision_source: tx.decisionSource ?? null,
    model_version: tx.modelVersion ?? null,
    reasons: (tx.reasons || []).join(','),
    created_at: tx.createdAt?.toISOString?.() ?? tx.createdAt,
    ...extra
  };
}

// Challenges resolve later, so only settled transactions are exported.
const SETTLED = ['COMPLETED', 'BLOCKED', 'FAILED'];

export async function landingBacklog() {
  const [pending, landed, lastBatch, recent] = await Promise.all([
    Transaction.countDocuments({ lakeLandedAt: null, status: { $in: SETTLED } }),
    Transaction.countDocuments({ lakeLandedAt: { $ne: null } }),
    LakeBatch.findOne({ error: null }).sort({ createdAt: -1 }),
    LakeBatch.find().sort({ createdAt: -1 }).limit(8)
  ]);
  return { pending, landed, lastBatch, recent, volume: VOLUME_PATH };
}

/**
 * Export settled, not-yet-landed transactions as one NDJSON file into the
 * landing volume, then mark them landed. The Bronze Auto Loader picks the file
 * up on the next medallion pipeline run.
 */
export async function landTransactions({ triggeredBy, limit = 5000 } = {}) {
  if (!databricksConfigured()) return { error: 'Databricks is not configured (DATABRICKS_HOST / DATABRICKS_TOKEN).' };
  const txns = await Transaction.find({ lakeLandedAt: null, status: { $in: SETTLED } }).sort({ createdAt: 1 }).limit(limit);
  if (!txns.length) return { rows: 0, message: 'Nothing new to land: every settled transaction is already in the lakehouse.' };

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const file = `${VOLUME_PATH}/data/transactions/dt=${day}/part-${now.getTime()}-api.json`;
  const body = txns.map((t) => JSON.stringify(transactionEvent(t, { published_at: now.toISOString(), source: 'api-landing' }))).join('\n');
  const put = await putVolumeFile(file, body);
  if (put.error) {
    await LakeBatch.create({ path: file, rows: 0, bytes: 0, triggeredBy, error: put.error });
    return { error: `Upload to ${VOLUME_PATH} failed: ${put.error}. Run Databricks → Set up / sync first if the volume does not exist.` };
  }
  await Transaction.updateMany({ _id: { $in: txns.map((t) => t._id) } }, { lakeLandedAt: now });
  const batch = await LakeBatch.create({ path: file, rows: txns.length, bytes: Buffer.byteLength(body), triggeredBy });
  return { rows: txns.length, path: file, batch };
}

/* ---------- public benchmark dataset (staged by the API: serverless has no internet egress) ---------- */

// The parquet file is uploaded as 4 MB parts plus a manifest (written last = staging complete):
// one 73 MB PUT times out on a slow uplink, small parts can be retried and resumed.
export const BENCHMARK = {
  source: 'https://data.openml.org/datasets/0000/1597/dataset_1597.pq',
  dir: `${VOLUME_PATH}/reference/creditcard`,
  path: `${VOLUME_PATH}/reference/creditcard/dataset_1597.manifest.json`,
  table: `${CATALOG}.${SCHEMA}.ref_creditcard`
};
const PART_BYTES = 4 * 1024 * 1024;
const UPLOAD_ATTEMPTS = 10;

/** { staged, cached }: file in the landing volume / Delta cache table (null = could not check). */
export async function benchmarkStatus() {
  const [staged, table] = await Promise.all([volumeFileExists(BENCHMARK.path), dbProbe(`/api/2.1/unity-catalog/tables/${BENCHMARK.table}`)]);
  const cached = !table || table.error ? null : !table.notFound;
  return { staged, cached, path: BENCHMARK.path, table: BENCHMARK.table, source: BENCHMARK.source };
}

/**
 * Download the OpenML parquet (~73 MB) on the API host and upload it into the Unity Catalog volume.
 * openml.org can be slow (tens of KB/s), so this runs in the background; progress is reported
 * through benchmarkStageJob() and shown on the Model training page. One job at a time.
 */
let stageJob = null;
const STAGE_SEGMENTS = 8;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bytes [from, to] of url; resumes after dropped connections (up to 15 retries). */
async function fetchRange(url, from, to, onBytes) {
  const chunks = [];
  let pos = from;
  let failures = 0;
  while (pos <= to) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${pos}-${to}` } });
      if (res.status !== 206) throw new Error(`range request answered HTTP ${res.status}`);
      for await (const c of res.body) { chunks.push(c); pos += c.length; onBytes(c.length); }
    } catch (err) {
      failures += 1;
      if (failures > 15) throw new Error(`download kept failing at byte ${pos}: ${err.message}`);
      await pause(2000 * Math.min(failures, 5));
    }
  }
  return Buffer.concat(chunks);
}
export const benchmarkStageJob = () => stageJob;

export function startStageBenchmark() {
  if (!databricksConfigured()) return { error: 'Databricks is not configured.' };
  if (stageJob && ['downloading', 'uploading'].includes(stageJob.state)) return stageJob;
  const job = { state: 'downloading', bytes: 0, total: null, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  stageJob = job;
  const fail = (msg) => { job.state = 'error'; job.error = msg; job.finishedAt = new Date().toISOString(); };
  (async () => {
    const head = await fetch(BENCHMARK.source, { method: 'HEAD' }).catch((err) => ({ ok: false, statusText: err.message }));
    if (!head.ok) return fail(`openml.org did not answer: ${head.status || ''} ${head.statusText}`);
    job.total = Number(head.headers.get('content-length'));
    if (!job.total) return fail('openml.org did not report the file size.');
    // openml.org is slow per connection and drops long downloads: fetch 8 ranges in
    // parallel, each resuming from its last byte after a dropped connection.
    // A finished download is kept in the OS temp folder, so a failed upload can be retried without downloading again.
    const local = path.join(os.tmpdir(), 'sentinelpay-openml-1597.pq');
    let body = await fs.readFile(local).catch(() => null);
    if (body?.length === job.total) {
      job.bytes = job.total;
    } else {
      const size = Math.ceil(job.total / STAGE_SEGMENTS);
      const ranges = Array.from({ length: STAGE_SEGMENTS }, (_, i) => [i * size, Math.min(job.total, (i + 1) * size) - 1]);
      const parts = await Promise.all(ranges.map(([from, to]) => fetchRange(BENCHMARK.source, from, to, (n) => { job.bytes += n; })));
      body = Buffer.concat(parts);
      if (body.length !== job.total) return fail(`Incomplete download: ${body.length} of ${job.total} bytes.`);
      await fs.writeFile(local, body);
    }
    job.state = 'uploading';
    job.uploaded = 0;
    const parts = [];
    for (let i = 0; i * PART_BYTES < body.length; i += 1) {
      const name = `dataset_1597.pq.part-${String(i).padStart(3, '0')}`;
      const chunk = body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES);
      parts.push(name);
      // resume: a part already uploaded with the right size is skipped
      if ((await volumeFileSize(`${BENCHMARK.dir}/${name}`)) !== chunk.length) {
        let put;
        // the uplink drops for minutes at a time, so wait it out before giving up
        for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
          put = await putVolumeFile(`${BENCHMARK.dir}/${name}`, chunk);
          if (!put.error) break;
          await pause(Math.min(10000 * attempt, 60000));
        }
        if (put.error) return fail(`Upload of ${name} failed after ${UPLOAD_ATTEMPTS} attempts: ${put.error}`);
      }
      job.uploaded += chunk.length;
    }
    const manifest = await putVolumeFile(BENCHMARK.path, JSON.stringify({ source: BENCHMARK.source, bytes: body.length, parts }));
    if (manifest.error) return fail(`Upload of the manifest failed: ${manifest.error}`);
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  })().catch((err) => fail(err.message));
  return job;
}
