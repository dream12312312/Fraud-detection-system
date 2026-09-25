const CATALOG = process.env.DATABRICKS_CATALOG || 'fraud';
const SCHEMA = process.env.DATABRICKS_SCHEMA || 'analytics';

/**
 * Thin REST client for the Databricks workspace used by this project.
 * Uses only the Databricks REST API v2.1 via fetch — no SDK, no polling loops.
 * Every function returns null (never throws) when Databricks is not configured
 * or unreachable, so the admin UI can show an honest "not configured" state
 * instead of fake data.
 */

const host = () => (process.env.DATABRICKS_HOST || '').replace(/\/+$/, '');
const token = () => process.env.DATABRICKS_TOKEN || '';

export function databricksConfigured() {
  return Boolean(host() && token());
}

async function dbGet(path) {
  if (!databricksConfigured()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${host()}${path}`, {
      headers: { Authorization: `Bearer ${token()}` },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`[databricks] GET ${path} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[databricks] GET ${path} failed:`, err.message);
    return null;
  }
}

async function dbPost(path, body) {
  if (!databricksConfigured()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(`${host()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[databricks] POST ${path} -> ${res.status}`, data);
      return { error: data.message || data.error || res.statusText, status: res.status };
    }
    return data;
  } catch (err) {
    console.error(`[databricks] POST ${path} failed:`, err.message);
    return null;
  }
}

/** GET that also reports 404s as { notFound: true } (used for existence checks). */
async function dbProbe(path) {
  if (!databricksConfigured()) return null;
  try {
    const res = await fetch(`${host()}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (res.status === 404) return { notFound: true };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.message || res.statusText, status: res.status };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

export { dbGet, dbPost, dbProbe };

/** Upload a file into a Unity Catalog volume (Files API). */
export async function putVolumeFile(path, content) {
  if (!databricksConfigured()) return { error: 'Databricks not configured' };
  try {
    const res = await fetch(`${host()}/api/2.0/fs/files${path}?overwrite=true`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/octet-stream' },
      body: content
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: data.message || res.statusText, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/** Output of one finished task run (dbutils.notebook.exit value). */
export async function getRunOutput(taskRunId) {
  return dbGet(`/api/2.1/jobs/runs/get-output?run_id=${taskRunId}`);
}

/** List workspace jobs that belong to the SentinelPay bundle. */
export async function listJobs() {
  // Databricks omits empty lists entirely ({}), so a successful empty reply means [] — only a failed call is null.
  const data = await dbGet('/api/2.1/jobs/list?limit=25');
  return data ? (data.jobs ?? []) : null;
}

/** Latest runs (any state) for a job. */
export async function listJobRuns(jobId, limit = 5) {
  const data = await dbGet(`/api/2.1/jobs/runs/list?job_id=${jobId}&limit=${limit}&expand_tasks=true`);
  return data ? (data.runs ?? []) : null;
}

/** Run a job now. Returns { run_id } or { error }. */
export async function runJob(jobId, jobParameters) {
  return dbPost(`/api/2.1/jobs/run-now`, { job_id: jobId, ...(jobParameters ? { job_parameters: jobParameters } : {}) });
}

/** Clear cached snapshots after a write (deploy, run-now) so the UI sees it at once. */
export function invalidateDatabricksCache() {
  databricksSnapshot.clear?.();
  medallionCounts.clear?.();
}

/** Get a run's current state + timing. */
export async function getRun(runId) {
  return dbGet(`/api/2.1/jobs/runs/get?run_id=${runId}`);
}

/**
 * Run a SQL statement and return { columns, rows }.
 * Used for real Bronze/Silver/Gold record counts against the Unity Catalog.
 * Uses the serverless statement execution warehouse — requires
 * DATABRICKS_WAREHOUSE_ID in .env for that call.
 */
export async function runSql(sql) {
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!databricksConfigured() || !warehouseId) return null;
  const start = await dbPost('/api/2.0/sql/statements', {
    warehouse_id: warehouseId,
    statement: sql,
    wait_timeout: '30s',
    format: 'JSON_ARRAY'
  });
  if (!start || start.error || start.status?.state !== 'SUCCEEDED') {
    if (start?.status?.error) console.error('[databricks] SQL failed:', start.status.error.message);
    return null;
  }
  // JSON_ARRAY returns positional rows; name them from the manifest.
  const cols = (start.manifest?.schema?.columns ?? []).map((c) => c.name);
  const rows = (start.result?.data_array ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  return { rows };
}

/**
 * Real Bronze/Silver/Gold record counts from the Unity Catalog tables.
 * Uses DESCRIBE TABLE (no warehouse needed for the count itself? — it does
 * need one, so it falls back to null when DATABRICKS_WAREHOUSE_ID is unset).
 */
// The admin UI polls every 5 s; without caching, COUNT(*) queries would keep the
// SQL warehouse awake (and billing) for as long as a monitoring tab is open.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  const get = async () => {
    if (Date.now() < expires) return value;
    inflight = inflight || fn().then((v) => { value = v; expires = Date.now() + ttlMs; return v; }).finally(() => { inflight = null; });
    return inflight;
  };
  get.clear = () => { expires = 0; };
  return get;
}

export const medallionCounts = cached(5 * 60 * 1000, medallionCountsUncached);

export const MEDALLION_TABLES = ['bronze_events', 'silver_events', 'silver_quarantine', 'gold_fraud_predictions', 'gold_fraud_kpis', 'gold_user_behavior', 'ml_dataset', 'ml_features'];

async function medallionCountsUncached() {
  // Only count tables that exist (Unity Catalog API, no warehouse), then one
  // UNION query — a missing table would otherwise fail the whole statement.
  const out = Object.fromEntries(MEDALLION_TABLES.map((t) => [t, null]));
  const present = [];
  for (const t of MEDALLION_TABLES) {
    const info = await dbProbe(`/api/2.1/unity-catalog/tables/${CATALOG}.${SCHEMA}.${t}`);
    if (info && !info.notFound && !info.error) present.push(t);
  }
  if (!present.length) return out;
  const sql = present.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM \`${CATALOG}\`.\`${SCHEMA}\`.\`${t}\``).join(' UNION ALL ');
  const res = await runSql(sql);
  for (const r of res?.rows ?? []) out[r.t] = r.n == null ? null : Number(r.n);
  return out;
}

/** List MLflow experiments in the workspace. */
export async function listMlflowExperiments() {
  const data = await dbGet('/api/2.0/mlflow/experiments/search?max_results=25');
  return data ? (data.experiments ?? []) : null;
}

/** Latest runs of one MLflow experiment. */
export async function listMlflowRuns(experimentId, limit = 10) {
  const data = await dbPost('/api/2.0/mlflow/runs/search', {
    experiment_ids: [String(experimentId)],
    max_results: limit,
    order_by: ['attributes.start_time DESC']
  });
  return data && !data.error ? (data.runs ?? []) : null;
}

/** Unity Catalog registered model that training registers versions into. */
export const REGISTERED_MODEL = process.env.DATABRICKS_MODEL_NAME || `${CATALOG}.${SCHEMA}.fraud_classifier`;

/** Latest versions of the Unity Catalog registered model ([] when it does not exist yet). */
export async function listModelVersions(modelName = REGISTERED_MODEL) {
  const data = await dbProbe(`/api/2.1/unity-catalog/models/${encodeURIComponent(modelName)}/versions?max_results=20`);
  if (!data || data.error) return null;
  if (data.notFound) return [];
  return (data.model_versions ?? []).sort((a, b) => Number(b.version) - Number(a.version)).map((v) => ({
    name: modelName, version: String(v.version), status: v.status, run_id: v.run_id,
    creation_timestamp: v.created_at, comment: v.comment
  }));
}

/**
 * One consolidated snapshot for the admin dashboard.
 * Returns nulls per section when not configured/available — the UI renders
 * those honestly, it never invents numbers.
 */
/** A retried task appears once per attempt; keep only each task's latest attempt, in job order. */
export function latestAttempts(tasks = []) {
  const byKey = new Map();
  for (const t of tasks) {
    const prev = byKey.get(t.task_key);
    if (!prev || (t.attempt_number ?? 0) >= (prev.attempt_number ?? 0)) byKey.set(t.task_key, t);
  }
  return [...byKey.values()];
}

export function taskState(t) {
  return {
    key: t.task_key,
    taskRunId: t.run_id,
    state: t.state?.life_cycle_state || null,
    result: t.state?.result_state || null,
    message: t.state?.state_message || null,
    startedAt: t.start_time ? new Date(t.start_time).toISOString() : null,
    finishedAt: t.end_time ? new Date(t.end_time).toISOString() : null
  };
}

export const databricksSnapshot = cached(20 * 1000, databricksSnapshotUncached);

let lastFinishedRun = null;
let seenFirstSnapshot = false;

async function databricksSnapshotUncached() {
  const configured = databricksConfigured();
  const snapshot = { configured, host: host() || null, jobs: null, catalog: `${CATALOG}.${SCHEMA}`, volume: process.env.DATABRICKS_VOLUME_PATH || '/Volumes/fraud/landing/events' };
  if (!configured) return snapshot;

  const jobs = await listJobs();
  const ours = (jobs || []).filter((j) => (j.settings?.name || '').toLowerCase().includes('sentinelpay'));
  snapshot.jobs = await Promise.all(ours.slice(0, 10).map(async (j) => {
    const runs = await listJobRuns(j.job_id, 3);
    const latest = runs?.[0] ?? null;
    return {
      jobId: j.job_id,
      name: j.settings?.name,
      latestRun: latest ? {
        runId: latest.run_id,
        state: latest.state?.life_cycle_state,
        resultState: latest.state?.result_state || null,
        startTime: latest.start_time ? new Date(latest.start_time).toISOString() : null,
        endTime: latest.end_time ? new Date(latest.end_time).toISOString() : null,
        tasks: latestAttempts(latest.tasks).map(taskState)
      } : null,
      recentRuns: (runs || []).map((r) => ({
        runId: r.run_id, state: r.state?.life_cycle_state, result: r.state?.result_state ?? null,
        startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
        endTime: r.end_time ? new Date(r.end_time).toISOString() : null,
        durationS: r.end_time && r.start_time ? Math.round((r.end_time - r.start_time) / 1000) : null
      }))
    };
  }));
  // A job run that just finished changed the tables: drop the cached row counts.
  const finished = snapshot.jobs.map((j) => j.latestRun?.endTime).filter(Boolean).sort().pop() || null;
  if (finished !== lastFinishedRun) { if (seenFirstSnapshot) medallionCounts.clear(); lastFinishedRun = finished; }
  seenFirstSnapshot = true;
  return snapshot;
}
