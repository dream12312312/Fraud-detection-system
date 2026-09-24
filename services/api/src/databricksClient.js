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

/** List workspace jobs that belong to the SentinelPay bundle. */
export async function listJobs() {
  const data = await dbGet('/api/2.1/jobs/list?limit=25');
  return data?.jobs ?? null;
}

/** Latest runs (any state) for a job. */
export async function listJobRuns(jobId, limit = 5) {
  const data = await dbGet(`/api/2.1/jobs/runs?job_id=${jobId}&limit=${limit}`);
  return data?.runs ?? null;
}

/** Run a job now. Returns { run_id } or { error }. */
export async function runJob(jobId) {
  return dbPost(`/api/2.1/jobs/run-now`, { job_id: jobId });
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
    format: 'ARRAY_OF_OBJECTS'
  });
  if (!start || start.error || !start.result) return null;
  const rows = start.result?.data_array ?? [];
  return { rows };
}

/**
 * Real Bronze/Silver/Gold record counts from the Unity Catalog tables.
 * Uses DESCRIBE TABLE (no warehouse needed for the count itself? — it does
 * need one, so it falls back to null when DATABRICKS_WAREHOUSE_ID is unset).
 */
export async function medallionCounts() {
  const tables = ['bronze_events', 'silver_events', 'gold_fraud_predictions', 'gold_fraud_kpis'];
  const out = {};
  for (const t of tables) {
    const res = await runSql(`SELECT COUNT(*) AS n FROM \`${CATALOG}\`.\`${SCHEMA}\`.\`${t}\``);
    out[t] = res?.rows?.[0]?.n ?? null;
  }
  return out;
}

/** List MLflow experiments in the workspace. */
export async function listMlflowExperiments() {
  const data = await dbGet('/api/2.0/mlflow/experiments/search?max_results=25');
  return data?.experiments ?? null;
}

/** Latest runs of one MLflow experiment. */
export async function listMlflowRuns(experimentId, limit = 10) {
  const data = await dbPost('/api/2.0/mlflow/runs/search', {
    experiment_ids: [String(experimentId)],
    max_results: limit,
    order_by: ['attributes.start_time DESC']
  });
  return data?.runs ?? null;
}

/** Latest versions of a registered model. */
export async function listModelVersions(modelName) {
  const data = await dbGet(`/api/2.0/mlflow/model-versions/search?name=${encodeURIComponent(modelName)}&max_results=10&order_by=version_number DESC`);
  return data?.model_versions ?? null;
}

/**
 * One consolidated snapshot for the admin dashboard.
 * Returns nulls per section when not configured/available — the UI renders
 * those honestly, it never invents numbers.
 */
export async function databricksSnapshot() {
  const configured = databricksConfigured();
  const snapshot = { configured, host: host() || null, jobs: null, catalog: `${CATALOG}.${SCHEMA}`, volume: process.env.DATABRICKS_VOLUME_PATH || '/Volumes/fraud/landing/events' };
  if (!configured) return snapshot;

  const jobs = await listJobs();
  const ours = (jobs || []).filter((j) => (j.settings?.name || '').toLowerCase().includes('sentinelpay'));
  snapshot.jobs = await Promise.all((ours.length ? ours : jobs ?? []).slice(0, 10).map(async (j) => {
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
        endTime: latest.end_time ? new Date(latest.end_time).toISOString() : null
      } : null,
      recentRuns: (runs || []).map((r) => ({ runId: r.run_id, state: r.state?.life_cycle_state, result: r.state?.result_state ?? null, startTime: r.start_time ? new Date(r.start_time).toISOString() : null }))
    };
  }));
  return snapshot;
}
