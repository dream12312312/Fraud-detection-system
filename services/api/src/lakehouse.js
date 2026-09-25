import { Transaction, LakeBatch } from './models.js';
import { putVolumeFile, databricksConfigured, volumeFileExists, dbProbe } from './databricksClient.js';
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

export const BENCHMARK = {
  source: 'https://data.openml.org/datasets/0000/1597/dataset_1597.pq',
  path: `${VOLUME_PATH}/reference/creditcard/dataset_1597.pq`,
  table: `${CATALOG}.${SCHEMA}.ref_creditcard`
};

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
export const benchmarkStageJob = () => stageJob;

export function startStageBenchmark() {
  if (!databricksConfigured()) return { error: 'Databricks is not configured.' };
  if (stageJob && ['downloading', 'uploading'].includes(stageJob.state)) return stageJob;
  const job = { state: 'downloading', bytes: 0, total: null, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  stageJob = job;
  const fail = (msg) => { job.state = 'error'; job.error = msg; job.finishedAt = new Date().toISOString(); };
  (async () => {
    const src = await fetch(BENCHMARK.source).catch((err) => ({ ok: false, statusText: err.message }));
    if (!src.ok) return fail(`Download from OpenML failed: ${src.status || ''} ${src.statusText}`);
    job.total = Number(src.headers.get('content-length')) || null;
    const chunks = [];
    for await (const chunk of src.body) { chunks.push(chunk); job.bytes += chunk.length; }
    if (job.total && job.bytes !== job.total) return fail(`Incomplete download: ${job.bytes} of ${job.total} bytes.`);
    job.state = 'uploading';
    const put = await putVolumeFile(BENCHMARK.path, Buffer.concat(chunks));
    if (put.error) return fail(`Upload to ${BENCHMARK.path} failed: ${put.error}`);
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  })().catch((err) => fail(err.message));
  return job;
}
