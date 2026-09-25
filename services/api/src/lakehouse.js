import { Transaction, LakeBatch } from './models.js';
import { putVolumeFile, databricksConfigured } from './databricksClient.js';
import { VOLUME_PATH } from './databricksProvision.js';

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
