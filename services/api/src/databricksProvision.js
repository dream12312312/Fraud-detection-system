import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbGet, dbPost, dbProbe, databricksConfigured, listJobs, invalidateDatabricksCache } from './databricksClient.js';

/**
 * Databricks workspace provisioning + health, done entirely over the REST API
 * from the server (the token never reaches a browser):
 *   Unity Catalog: catalog, schemas (analytics, landing), landing volume
 *   Workspace:     the repo's notebooks uploaded under /Users/<me>/sentinelpay
 *   Jobs:          medallion pipeline + model training, created or updated in place
 * Every step is idempotent, so "Set up / sync" is also how notebook edits get deployed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTEBOOK_DIR = path.resolve(here, '../../../databricks/notebooks');

export const CATALOG = process.env.DATABRICKS_CATALOG || 'fraud';
export const SCHEMA = process.env.DATABRICKS_SCHEMA || 'analytics';
export const LANDING_SCHEMA = 'landing';
export const VOLUME_PATH = `/Volumes/${CATALOG}/${LANDING_SCHEMA}/events`;

export const JOBS = {
  medallion: {
    name: 'sentinelpay-medallion-pipeline',
    tasks: [['bronze', '01_bronze'], ['silver', '02_silver'], ['gold', '03_gold']],
    parameters: { catalog: CATALOG, schema: SCHEMA }
  },
  training: {
    name: 'sentinelpay-model-training',
    tasks: [['load_dataset', '10_load_dataset'], ['build_features', '11_build_features'], ['train_model', '12_train_model'], ['evaluate_register', '13_evaluate_register']],
    parameters: { catalog: CATALOG, schema: SCHEMA, model: 'logistic_regression', dataset: 'synthetic_payments', seed: '42', sentinelpay_run_id: '' }
  }
};

const NOTEBOOKS = [...new Set(Object.values(JOBS).flatMap((j) => j.tasks.map(([, nb]) => nb)))];

let me = null;
export async function currentUser() {
  if (me) return me;
  const data = await dbGet('/api/2.0/preview/scim/v2/Me');
  me = data?.userName || null;
  return me;
}

const workspaceDir = (user) => `/Users/${user}/sentinelpay/notebooks`;

function jobSettings(key, user) {
  const def = JOBS[key];
  return {
    name: def.name,
    max_concurrent_runs: 1,
    queue: { enabled: true },
    tags: { project: 'sentinelpay', managed_by: 'sentinelpay-admin-console' },
    parameters: Object.entries(def.parameters).map(([name, dflt]) => ({ name, default: dflt })),
    tasks: def.tasks.map(([taskKey, nb], i) => ({
      task_key: taskKey,
      ...(i > 0 ? { depends_on: [{ task_key: def.tasks[i - 1][0] }] } : {}),
      notebook_task: { notebook_path: `${workspaceDir(user)}/${nb}`, source: 'WORKSPACE' }
    }))
  };
}

const ok = (step, detail) => ({ step, ok: true, detail });
const fail = (step, detail) => ({ step, ok: false, detail });

/** Run one DDL statement on the SQL warehouse; returns null on success or the error text. */
async function sqlDdl(statement) {
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) return 'DATABRICKS_WAREHOUSE_ID not set';
  const r = await dbPost('/api/2.0/sql/statements', { warehouse_id: warehouseId, statement, wait_timeout: '50s' });
  if (!r || r.error) return r?.error || 'no response';
  return r.status?.state === 'SUCCEEDED' ? null : (r.status?.error?.message || r.status?.state);
}

// REST first; if the workspace refuses (Free Edition "Default Storage" only lets
// SQL create catalogs), fall back to the same DDL as setup_catalog.sql.
async function ensureUc(step, probePath, createPath, body, ddl) {
  const found = await dbProbe(probePath);
  if (found && !found.notFound && !found.error) return ok(step, 'already exists');
  if (found?.error) return fail(step, found.error);
  const created = await dbPost(createPath, body);
  if (created && !created.error) return ok(step, 'created');
  const sqlError = ddl ? await sqlDdl(ddl) : 'no SQL fallback';
  return sqlError ? fail(step, `${created?.error || 'no response'} / SQL: ${sqlError}`) : ok(step, 'created (SQL)');
}

/** Create or update everything the pipeline and training need. Returns per-step results. */
export async function provisionWorkspace() {
  if (!databricksConfigured()) return { ok: false, steps: [fail('connection', 'DATABRICKS_HOST / DATABRICKS_TOKEN not set')] };
  const steps = [];
  const user = await currentUser();
  if (!user) return { ok: false, steps: [fail('connection', 'could not identify the token owner (check the token)')] };
  steps.push(ok('connection', `connected as ${user}`));

  steps.push(await ensureUc(`catalog ${CATALOG}`, `/api/2.1/unity-catalog/catalogs/${CATALOG}`, '/api/2.1/unity-catalog/catalogs', { name: CATALOG, comment: 'SentinelPay fraud lakehouse' },
    `CREATE CATALOG IF NOT EXISTS \`${CATALOG}\``));
  for (const s of [SCHEMA, LANDING_SCHEMA]) {
    steps.push(await ensureUc(`schema ${CATALOG}.${s}`, `/api/2.1/unity-catalog/schemas/${CATALOG}.${s}`, '/api/2.1/unity-catalog/schemas', { name: s, catalog_name: CATALOG },
      `CREATE SCHEMA IF NOT EXISTS \`${CATALOG}\`.\`${s}\``));
  }
  steps.push(await ensureUc(`volume ${CATALOG}.${LANDING_SCHEMA}.events`, `/api/2.1/unity-catalog/volumes/${CATALOG}.${LANDING_SCHEMA}.events`, '/api/2.1/unity-catalog/volumes',
    { name: 'events', catalog_name: CATALOG, schema_name: LANDING_SCHEMA, volume_type: 'MANAGED' },
    `CREATE VOLUME IF NOT EXISTS \`${CATALOG}\`.\`${LANDING_SCHEMA}\`.events`));

  const dir = workspaceDir(user);
  const mk = await dbPost('/api/2.0/workspace/mkdirs', { path: dir });
  if (!mk || mk.error) steps.push(fail(`folder ${dir}`, mk?.error || 'no response'));
  let uploaded = 0;
  for (const nb of NOTEBOOKS) {
    const source = await fs.readFile(path.join(NOTEBOOK_DIR, `${nb}.py`), 'utf8');
    const r = await dbPost('/api/2.0/workspace/import', {
      path: `${dir}/${nb}`, format: 'SOURCE', language: 'PYTHON', overwrite: true,
      content: Buffer.from(source, 'utf8').toString('base64')
    });
    if (!r || r.error) steps.push(fail(`notebook ${nb}`, r?.error || 'no response'));
    else uploaded += 1;
  }
  steps.push(uploaded === NOTEBOOKS.length ? ok('notebooks', `${uploaded} uploaded to ${dir}`) : fail('notebooks', `${uploaded}/${NOTEBOOKS.length} uploaded`));

  const jobs = (await listJobs()) || [];
  for (const key of Object.keys(JOBS)) {
    const settings = jobSettings(key, user);
    const existing = jobs.find((j) => j.settings?.name === settings.name);
    const r = existing
      ? await dbPost('/api/2.1/jobs/reset', { job_id: existing.job_id, new_settings: settings })
      : await dbPost('/api/2.1/jobs/create', settings);
    if (!r || r.error) steps.push(fail(`job ${settings.name}`, r?.error || 'no response'));
    else steps.push(ok(`job ${settings.name}`, existing ? `updated (job ${existing.job_id})` : `created (job ${r.job_id})`));
  }

  invalidateDatabricksCache();
  return { ok: steps.every((s) => s.ok), steps };
}

/** Read-only health of every Databricks resource the platform depends on. */
export async function workspaceStatus() {
  const host = (process.env.DATABRICKS_HOST || '').replace(/\/+$/, '') || null;
  if (!databricksConfigured()) return { configured: false, host, checks: [] };
  const user = await currentUser();
  const checks = [];
  const add = (key, label, state, detail, url) => checks.push({ key, label, state, detail, url: url || null });
  add('connection', 'Workspace connection', user ? 'ok' : 'error', user ? `token owner ${user}` : 'token rejected or workspace unreachable', host);

  const whId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (whId) {
    const wh = await dbProbe(`/api/2.0/sql/warehouses/${whId}`);
    add('warehouse', 'SQL warehouse', wh?.state ? 'ok' : 'error',
      wh?.state ? `${wh.name} · ${wh.state}${wh.state === 'STOPPED' ? ' (starts on demand)' : ''}` : (wh?.error || 'not found'),
      host ? `${host}/sql/warehouses/${whId}` : null);
  } else add('warehouse', 'SQL warehouse', 'missing', 'DATABRICKS_WAREHOUSE_ID not set — row counts unavailable');

  const uc = async (key, label, probe, url) => {
    const r = await dbProbe(probe);
    add(key, label, r?.notFound ? 'missing' : r?.error ? 'error' : 'ok', r?.notFound ? 'not created yet' : r?.error || 'exists', url);
  };
  await uc('catalog', `Catalog ${CATALOG}`, `/api/2.1/unity-catalog/catalogs/${CATALOG}`, host && `${host}/explore/data/${CATALOG}`);
  await uc('schema', `Schema ${CATALOG}.${SCHEMA}`, `/api/2.1/unity-catalog/schemas/${CATALOG}.${SCHEMA}`, host && `${host}/explore/data/${CATALOG}/${SCHEMA}`);
  await uc('volume', `Landing volume ${VOLUME_PATH}`, `/api/2.1/unity-catalog/volumes/${CATALOG}.${LANDING_SCHEMA}.events`, host && `${host}/explore/data/volumes/${CATALOG}/${LANDING_SCHEMA}/events`);

  if (user) {
    const listing = await dbProbe(`/api/2.0/workspace/list?path=${encodeURIComponent(workspaceDir(user))}`);
    const names = (listing?.objects || []).map((o) => o.path.split('/').pop());
    const missing = NOTEBOOKS.filter((nb) => !names.includes(nb));
    add('notebooks', 'Pipeline notebooks', missing.length === 0 ? 'ok' : 'missing',
      missing.length === 0 ? `${NOTEBOOKS.length} notebooks in ${workspaceDir(user)}` : `missing: ${missing.join(', ')}`,
      host ? `${host}/#workspace${workspaceDir(user)}` : null);
  }

  const jobs = (await listJobs()) || [];
  for (const def of Object.values(JOBS)) {
    const j = jobs.find((x) => x.settings?.name === def.name);
    add(`job:${def.name}`, `Job ${def.name}`, j ? 'ok' : 'missing', j ? `job id ${j.job_id}` : 'not deployed', j && host ? `${host}/jobs/${j.job_id}` : null);
  }
  return { configured: true, host, user, catalog: `${CATALOG}.${SCHEMA}`, volume: VOLUME_PATH, checks, ready: checks.every((c) => c.state === 'ok') };
}
