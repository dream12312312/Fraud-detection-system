/**
 * Data-flow monitoring for the admin console, built only from real sources:
 * MongoDB (payments, landing batches), the Databricks Jobs API (runs, task
 * timings, notebook outputs) and the Unity Catalog row counts.
 *
 * It answers the questions a data engineer asks of a pipeline:
 *   how much data is at each stage, what is waiting between stages,
 *   how fresh each layer is, where rows went in the last run (reconciliation),
 *   how long each processing step takes, and how fast payments are scored.
 */
import { Transaction, LakeBatch } from './models.js';
import { databricksSnapshot, medallionCounts, listJobRuns, getRunOutput, latestAttempts, taskState } from './databricksClient.js';
import { JOBS } from './databricksProvision.js';
import { landingBacklog } from './lakehouse.js';

const SCORED = ['TRANSFER', 'PAYMENT'];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/** Hot path: payments per minute (last 60 min) and measured scoring latency. */
async function hotPath() {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [perMinute, recent, sources, stuck, awaiting] = await Promise.all([
    Transaction.aggregate([
      { $match: { createdAt: { $gte: since }, type: { $in: SCORED } } },
      { $group: {
        _id: { $dateTrunc: { date: '$createdAt', unit: 'minute' } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        challenged: { $sum: { $cond: [{ $eq: ['$status', 'CHALLENGED'] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] } },
        other: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'CHALLENGED', 'BLOCKED']] }, 0, 1] } }
      } },
      { $sort: { _id: 1 } }
    ]),
    Transaction.find({ 'timings.totalMs': { $ne: null } }).sort({ createdAt: -1 }).limit(200).select('timings createdAt').lean(),
    Transaction.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, type: { $in: SCORED } } },
      { $group: { _id: '$decisionSource', n: { $sum: 1 } } }
    ]),
    Transaction.countDocuments({ status: 'PENDING_RISK_CHECK' }),
    Transaction.countDocuments({ status: 'CHALLENGED' })
  ]);
  const score = recent.map((t) => t.timings.scoreMs).filter((v) => v != null).sort((a, b) => a - b);
  const total = recent.map((t) => t.timings.totalMs).filter((v) => v != null).sort((a, b) => a - b);
  return {
    perMinute: perMinute.map((m) => ({ t: m._id, completed: m.completed, challenged: m.challenged, blocked: m.blocked, other: m.other })),
    lastHour: perMinute.reduce((a, m) => a + m.completed + m.challenged + m.blocked + m.other, 0),
    latency: {
      samples: total.length,
      since: recent.at(-1)?.createdAt ?? null,
      scoreP50: quantile(score, 0.5), scoreP95: quantile(score, 0.95),
      totalP50: quantile(total, 0.5), totalP95: quantile(total, 0.95), totalMax: total.at(-1) ?? null
    },
    sources24h: Object.fromEntries(sources.map((s) => [s._id || 'NONE', s.n])),
    stuck,
    awaitingCustomer: awaiting
  };
}

/* Notebook outputs of finished task runs never change: cache them by task run id. */
const outputs = new Map();
async function taskOutput(taskRunId) {
  if (outputs.has(taskRunId)) return outputs.get(taskRunId);
  const out = await getRunOutput(taskRunId);
  const raw = out?.notebook_output?.result;
  if (raw == null) return null; // not cached: may be a transient API failure
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  outputs.set(taskRunId, parsed);
  return parsed;
}

/* Run history with per-task timings; refreshed when the job's latest run changes, or every 60 s. */
let runsCache = { key: null, at: 0, value: null };
async function medallionRuns(job) {
  const key = `${job.jobId}:${job.latestRun?.runId}:${job.latestRun?.state}`;
  if (runsCache.key === key && Date.now() - runsCache.at < 60000) return runsCache.value;
  const runs = await listJobRuns(job.jobId, 10);
  if (runs == null) return runsCache.value; // keep the last good history on an API timeout
  const value = runs.map((r) => ({
    runId: r.run_id,
    state: r.state?.life_cycle_state || null,
    result: r.state?.result_state || null,
    startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
    endTime: r.end_time ? new Date(r.end_time).toISOString() : null,
    tasks: latestAttempts(r.tasks).map(taskState)
  }));
  runsCache = { key, at: Date.now(), value };
  return value;
}

export async function dataflowSnapshot() {
  const [hot, lake, snap, counts, newest] = await Promise.all([
    hotPath(), landingBacklog(), databricksSnapshot(), medallionCounts(),
    Transaction.findOne().sort({ createdAt: -1 }).select('createdAt').lean()
  ]);
  const job = (snap.jobs || []).find((j) => j.name === JOBS.medallion.name) || null;
  const runs = job ? await medallionRuns(job) : null;
  const lastOk = (runs || []).find((r) => r.result === 'SUCCESS') || null;

  // Rows landed after the last successful run started have not reached Bronze yet.
  const sinceRun = lastOk ? new Date(lastOk.startTime) : null;
  const unprocessed = await LakeBatch.aggregate([
    { $match: { error: null, rows: { $gt: 0 }, ...(sinceRun ? { createdAt: { $gt: sinceRun } } : {}) } },
    { $group: { _id: null, rows: { $sum: '$rows' }, files: { $sum: 1 } } }
  ]);
  const waitingForBronze = unprocessed[0]?.rows ?? 0;

  // Where the rows went in the last successful run (the notebooks' own exit values).
  let reconciliation = null;
  if (lastOk) {
    const byKey = Object.fromEntries(lastOk.tasks.map((t) => [t.key, t]));
    const [bronze, silver, gold] = await Promise.all(['bronze', 'silver', 'gold'].map((k) => (byKey[k]?.taskRunId ? taskOutput(byKey[k].taskRunId) : null)));
    reconciliation = { runId: lastOk.runId, endTime: lastOk.endTime, bronze, silver, gold };
  }

  const at = (iso) => iso || null;
  return {
    time: new Date().toISOString(),
    hot,
    stages: [
      { id: 'source', label: 'MongoDB', rows: await Transaction.countDocuments({}), freshAt: at(newest?.createdAt), notExported: { awaitingCustomer: hot.awaitingCustomer, stuck: hot.stuck } },
      { id: 'landing', label: 'Landing volume', rows: lake.landed, freshAt: at(lake.lastBatch?.createdAt), waitingIn: lake.pending },
      { id: 'bronze', label: 'Bronze', rows: counts.bronze_events, freshAt: at(lastOk?.endTime), waitingIn: waitingForBronze },
      { id: 'silver', label: 'Silver', rows: counts.silver_events, quarantined: counts.silver_quarantine, freshAt: at(lastOk?.endTime) },
      { id: 'gold', label: 'Gold', rows: counts.gold_fraud_predictions, freshAt: at(lastOk?.endTime) }
    ],
    // Settled payments that are not in Gold yet: not landed + landed after the last successful run.
    goldBehind: lake.pending + waitingForBronze,
    reconciliation,
    runs,
    job: job ? { jobId: job.jobId, name: job.name } : null,
    host: snap.host || null
  };
}
